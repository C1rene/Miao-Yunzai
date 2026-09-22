import Renderer from "../../../lib/renderer/Renderer.js"
import os from "node:os"
import lodash from "lodash"
import puppeteer from "puppeteer"
import timers from "node:timers/promises"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
// 暂时保留对原config的兼容
import cfg from "../../../lib/config/config.js"

const _path = process.cwd()
const execFileAsync = promisify(execFile)
// mac地址
let mac = ""

export default class Puppeteer extends Renderer {
  constructor(config) {
    super({
      id: "puppeteer",
      type: "image",
      render: "screenshot",
    })
    this.browser = false
    this.lock = false
    this.shoting = []
    /** 截图数达到时重启浏览器 避免生成速度越来越慢 */
    this.restartNum = 100
    /** 截图次数 */
    this.renderNum = 0
    this.config = {
      userDataDir: config.userDataDir || "data/puppeteer",
      headless: config.headless || "new",
      args: config.args || [
        "--disable-gpu",
        "--disable-setuid-sandbox",
        "--no-sandbox",
        "--no-zygote",
      ],
    }
    if (config.chromiumPath || cfg?.bot?.chromium_path)
      /** chromium其他路径 */
      this.config.executablePath = config.chromiumPath || cfg?.bot?.chromium_path
    if (config.puppeteerWS || cfg?.bot?.puppeteer_ws)
      /** chromium其他路径 */
      this.config.wsEndpoint = config.puppeteerWS || cfg?.bot?.puppeteer_ws
    /** puppeteer超时超时时间 */
    this.puppeteerTimeout = config.puppeteerTimeout || cfg?.bot?.puppeteer_timeout || 0
    this.pageGotoParams = config.pageGotoParams || {
      timeout: 120000,
      waitUntil: "networkidle2",
    }
  }

  /**
   * 初始化chromium
   * @param retryCount userDataDir 被占用时的自动恢复重试次数
   */
  async browserInit(retryCount = 0) {
    if (this.browser) return this.browser
    if (this.lock) return false
    this.lock = true

    logger.info("puppeteer Chromium 启动中...")

    let connectFlag = false
    try {
      // 获取Mac地址
      if (!mac) {
        mac = await this.getMac()
        this.browserMacKey = `Yz:chromium:browserWSEndpoint:${mac}`
      }
      // 是否有browser实例
      const browserUrl = (await redis.get(this.browserMacKey)) || this.config.wsEndpoint
      if (browserUrl) {
        try {
          const browserWSEndpoint = await puppeteer.connect({ browserWSEndpoint: browserUrl })
          // 如果有实例，直接使用
          if (browserWSEndpoint) {
            this.browser = browserWSEndpoint
            connectFlag = true
          }
          logger.info(`puppeteer Chromium 连接成功 ${browserUrl}`)
        } catch (err) {
          await redis.del(this.browserMacKey)
        }
      }
    } catch {}

    let needRetry = false

    if (!this.browser || !connectFlag) {
      // 如果没有实例，初始化puppeteer
      this.browser = await puppeteer.launch(this.config).catch(async (err, trace) => {
        const errMsg = err.toString() + (trace ? trace.toString() : "")
        logger.error(err, trace)
        if (errMsg.includes("Could not find Chromium")) {
          logger.error(
            "没有正确安装 Chromium，可以尝试执行安装命令：node node_modules/puppeteer/install.js",
          )
        } else if (errMsg.includes("cannot open shared object file")) {
          logger.error("没有正确安装 Chromium 运行库")
        } else {
          const userDataDir = path.resolve(process.cwd(), this.config.userDataDir)
          const normalizePath = value => String(value).replaceAll("\\", "/").toLowerCase()
          const normalizedErrMsg = normalizePath(errMsg)
          const normalizedUserDataDir = normalizePath(userDataDir)
          const normalizedConfigUserDataDir = normalizePath(this.config.userDataDir)

          if (
            normalizedErrMsg.includes(normalizedUserDataDir) ||
            normalizedErrMsg.includes(normalizedConfigUserDataDir)
          ) {
            logger.warn(`[puppeteer] 检测到 userDataDir 被占用: ${userDataDir}`)

            if (retryCount >= 1) {
              logger.error("[puppeteer] 自动恢复后仍然被占用，停止继续重试，避免死循环")
              return false
            }

            const recovered = await this.recoverUserDataDir(userDataDir)
            if (recovered) needRetry = true
          }
        }
        return false
      })

      if (needRetry) {
        this.browser = false
        this.lock = false
        logger.warn("[puppeteer] 残留 Chromium 已处理，准备自动重试一次")
        await timers.setTimeout(500)
        return this.browserInit(retryCount + 1)
      }
    }

    this.lock = false
    if (!this.browser) {
      logger.error("puppeteer Chromium 启动失败")
      return false
    }
    if (!connectFlag) {
      logger.info(`puppeteer Chromium 启动成功 ${this.browser.wsEndpoint()}`)
      if (this.browserMacKey) {
        // 缓存一下实例30天
        const expireTime = 60 * 60 * 24 * 30
        await redis.set(this.browserMacKey, this.browser.wsEndpoint(), { EX: expireTime })
      }
    }

    /** 监听Chromium实例是否断开 */
    this.browser.on("disconnected", () => this.restart(true))

    return this.browser
  }

  /** Windows 下精确查找使用当前 userDataDir 的 Chromium 进程 */
  async findWindowsChromiumPids(userDataDir, strictExecutable = true) {
    if (process.platform !== "win32") return []

    const executablePath = this.config.executablePath
      ? path.resolve(process.cwd(), this.config.executablePath)
      : ""

    const psScript = String.raw`
$profile = [IO.Path]::GetFullPath($env:MIAO_PUPPETEER_USER_DATA_DIR)
$profileNorm = $profile.Replace([char]47, [char]92).TrimEnd([char]92).ToLowerInvariant()
$exeNorm = ''
if (-not [string]::IsNullOrWhiteSpace($env:MIAO_PUPPETEER_EXECUTABLE)) {
  $exeNorm = ([IO.Path]::GetFullPath($env:MIAO_PUPPETEER_EXECUTABLE)).Replace([char]47, [char]92).ToLowerInvariant()
}
$strictExe = $env:MIAO_PUPPETEER_STRICT_EXE -eq '1'

Get-CimInstance Win32_Process | Where-Object {
  if ([string]::IsNullOrWhiteSpace($_.CommandLine)) { return $false }

  $cmdNorm = $_.CommandLine.Replace([char]47, [char]92).ToLowerInvariant()
  if (-not $cmdNorm.Contains($profileNorm)) { return $false }

  if ($strictExe -and -not [string]::IsNullOrWhiteSpace($exeNorm)) {
    if ([string]::IsNullOrWhiteSpace($_.ExecutablePath)) { return $false }
    $procExeNorm = ([IO.Path]::GetFullPath($_.ExecutablePath)).Replace([char]47, [char]92).ToLowerInvariant()
    if ($procExeNorm -ne $exeNorm) { return $false }
  }

  return $true
} | Sort-Object ProcessId | ForEach-Object { $_.ProcessId }
`

    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
        {
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            MIAO_PUPPETEER_USER_DATA_DIR: userDataDir,
            MIAO_PUPPETEER_EXECUTABLE: executablePath,
            MIAO_PUPPETEER_STRICT_EXE: strictExecutable ? "1" : "0",
          },
        },
      )

      return String(stdout)
        .split(/\r?\n/)
        .map(v => Number.parseInt(v.trim(), 10))
        .filter(Number.isInteger)
    } catch (err) {
      logger.error(`[puppeteer] 查询残留 Chromium 进程失败: ${err}`)
      return []
    }
  }

  /** 强制结束一个 Windows 进程及其整个子进程树 */
  async killWindowsProcessTree(pid) {
    if (process.platform !== "win32" || !Number.isInteger(pid)) return false

    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
      logger.warn(`[puppeteer] 已强制结束 Chromium 进程树 PID=${pid}`)
      return true
    } catch (err) {
      const msg = String(err?.stderr || err?.stdout || err?.message || err).trim()
      logger.warn(`[puppeteer] 结束 PID=${pid} 时返回: ${msg}`)
      return false
    }
  }

  /** userDataDir 被旧 Chromium 占用时进行一次自动恢复 */
  async recoverUserDataDir(userDataDir) {
    try {
      if (this.browserMacKey) await redis.del(this.browserMacKey).catch(() => {})

      if (process.platform === "win32") {
        let pids = await this.findWindowsChromiumPids(userDataDir, true)

        if (pids.length === 0) {
          logger.warn("[puppeteer] 未找到严格匹配 chromium_path 的进程，改为按 userDataDir 查找残留")
          pids = await this.findWindowsChromiumPids(userDataDir, false)
        }

        if (pids.length > 0) {
          logger.warn(`[puppeteer] 找到占用 userDataDir 的进程 PID: ${pids.join(", ")}`)
          for (const pid of pids) await this.killWindowsProcessTree(pid)
          await timers.setTimeout(800)
        } else {
          logger.warn("[puppeteer] 未查询到占用 userDataDir 的 Chromium 进程")
        }
      }

      try {
        await fs.rm(userDataDir, { force: true, recursive: true })
      } catch (firstRemoveErr) {
        if (process.platform !== "win32") throw firstRemoveErr

        logger.warn(`[puppeteer] 第一次清理 userDataDir 仍失败: ${firstRemoveErr}`)
        const remainingPids = await this.findWindowsChromiumPids(userDataDir, false)

        if (remainingPids.length > 0) {
          logger.warn(`[puppeteer] 发现剩余进程 PID: ${remainingPids.join(", ")}`)
          for (const pid of remainingPids) await this.killWindowsProcessTree(pid)
          await timers.setTimeout(800)
        }

        await fs.rm(userDataDir, { force: true, recursive: true })
      }

      logger.warn(`[puppeteer] 已清理 userDataDir: ${userDataDir}`)
      return true
    } catch (err) {
      logger.error(`[puppeteer] 自动恢复失败: ${err}`)
      return false
    }
  }

  // 获取Mac地址
  getMac() {
    let mac = "00:00:00:00:00:00"
    try {
      const network = os.networkInterfaces()
      let macFlag = false
      for (const a in network) {
        for (const i of network[a]) {
          if (i.mac && i.mac !== mac) {
            macFlag = true
            mac = i.mac
            break
          }
        }
        if (macFlag) {
          break
        }
      }
    } catch (e) {}
    mac = mac.replace(/:/g, "")
    return mac
  }

  /**
   * `chromium` 截图
   * @param name
   * @param data 模板参数
   * @param data.tplFile 模板路径，必传
   * @param data.saveId  生成html名称，为空name代替
   * @param data.imgType  screenshot参数，生成图片类型：jpeg，png
   * @param data.quality  screenshot参数，图片质量 0-100，jpeg是可传，默认90
   * @param data.omitBackground  screenshot参数，隐藏默认的白色背景，背景透明。默认不透明
   * @param data.path   screenshot参数，截图保存路径。截图图片类型将从文件扩展名推断出来。如果是相对路径，则从当前路径解析。如果没有指定路径，图片将不会保存到硬盘。
   * @param data.multiPage 是否分页截图，默认false
   * @param data.multiPageHeight 分页状态下页面高度，默认4000
   * @param data.pageGotoParams 页面goto时的参数
   * @return img 不做segment包裹
   */
  async screenshot(name, data = {}) {
    if (!(await this.browserInit())) return false
    const pageHeight = data.multiPageHeight || 4000

    const savePath = this.dealTpl(name, data)
    if (!savePath) return false

    let buff = ""
    const start = Date.now()

    let ret = []
    this.shoting.push(name)

    const puppeteerTimeout = this.puppeteerTimeout
    let overtime
    if (puppeteerTimeout > 0) {
      // TODO 截图超时处理
      overtime = setTimeout(() => {
        if (this.shoting.length) {
          logger.error(`[图片生成][${name}] 截图超时，当前等待队列：${this.shoting.join(",")}`)
          this.restart(true)
          this.shoting = []
        }
      }, puppeteerTimeout)
    }

    try {
      const page = await this.browser.newPage()
      const pageGotoParams = lodash.extend(this.pageGotoParams, data.pageGotoParams || {})
      await page.goto(`file://${_path}${lodash.trim(savePath, ".")}`, pageGotoParams)
      const body = (await page.$("#container")) || (await page.$("body"))

      // 计算页面高度
      const boundingBox = await body.boundingBox()
      // 分页数
      let num = 1

      const randData = {
        type: data.imgType || "jpeg",
        omitBackground: data.omitBackground || false,
        quality: data.quality || 90,
        path: data.path || "",
      }

      if (data.multiPage) {
        randData.type = "jpeg"
        num = Math.round(boundingBox.height / pageHeight) || 1
      }

      if (data.imgType === "png") delete randData.quality

      if (!data.multiPage) {
        buff = await body.screenshot(randData)
        if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)

        this.renderNum++
        /** 计算图片大小 */
        const kb = (buff.length / 1024).toFixed(2) + "KB"
        logger.mark(
          `[图片生成][${name}][${this.renderNum}次] ${kb} ${logger.green(`${Date.now() - start}ms`)}`,
        )
        ret.push(buff)
      } else {
        // 分片截图
        if (num > 1) {
          await page.setViewport({
            width: boundingBox.width,
            height: pageHeight + 100,
          })
        }
        for (let i = 1; i <= num; i++) {
          if (i !== 1 && i === num)
            await page.setViewport({
              width: boundingBox.width,
              height: parseInt(boundingBox.height) - pageHeight * (num - 1),
            })

          if (i !== 1 && i <= num)
            await page.evaluate(pageHeight => window.scrollBy(0, pageHeight), pageHeight)

          if (num === 1) buff = await body.screenshot(randData)
          else buff = await page.screenshot(randData)
          if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)

          if (num > 2) await timers.setTimeout(200)

          this.renderNum++

          /** 计算图片大小 */
          const kb = (buff.length / 1024).toFixed(2) + "KB"
          logger.mark(`[图片生成][${name}][${i}/${num}] ${kb}`)
          ret.push(buff)
        }
        if (num > 1) {
          logger.mark(`[图片生成][${name}] 处理完成`)
        }
      }
      page.close().catch(err => logger.error(err))
    } catch (err) {
      logger.error(`[图片生成][${name}] 图片生成失败`, err)
      /** 关闭浏览器 */
      this.restart(true)
      if (overtime) clearTimeout(overtime)
      ret = []
      return false
    } finally {
      if (overtime) clearTimeout(overtime)
    }

    this.shoting.pop()

    if (ret.length === 0 || !ret[0]) {
      logger.error(`[图片生成][${name}] 图片生成为空`)
      return false
    }

    this.restart()
    return data.multiPage ? ret : ret[0]
  }

  /** 重启 */
  restart(force = false) {
    /** 截图超过重启数时，自动关闭重启浏览器，避免生成速度越来越慢 */
    if (!this.browser?.close || this.lock) return
    if (!force) if (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0) return
    logger.info(`puppeteer Chromium ${force ? "强制" : ""}关闭重启...`)
    this.stop(this.browser)
    this.browser = false
    return this.browserInit()
  }

  async stop(browser) {
    try {
      await browser.close()
    } catch (err) {
      logger.error("puppeteer Chromium 关闭错误", err)
    }
  }
}
