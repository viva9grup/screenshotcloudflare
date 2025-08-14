import puppeteer from "@cloudflare/puppeteer"
import { regexMerge } from "./support"

export default {
  async fetch(request, env, ctx) {
    const cache = caches.default

    const screenshot = await cache.match(request.url)

    if (screenshot) {
      return screenshot
    }

    const browser = env.BROWSER.get(env.BROWSER.idFromName("browser"))

    const response = await browser.fetch(request.url)

    ctx.waitUntil(cache.put(request.url, response.clone()))

    return response
  }
}

const pattern = regexMerge(
  /^(?<base>https:\/\/[\w\.\/]+)\/screenshots?/,
  /(?:\/(?<width>[0-9]+)x(?<height>[0-9]+))?/,
  /(?<path>\/.*?)/,
  /(?:@(?<scale>[2-4])x)?/,
  /(?:\.(?<format>(pdf|png)))?/,
  /(?<query>\?.*)?$/,
)

const defaults = {
  format: "png",
  width: 1200,
  height: 630,
  maxage: 60 * 60 * 24 * 7,
  scale: 1,
}

const KEEP_BROWSER_ALIVE_IN_SECONDS = 60

export class Browser {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.keptAliveInSeconds = 0
    this.storage = this.state.storage
  }

  async fetch(request) {
    const settings = request.url.match(pattern).groups

    const { base, format, path, width, height, maxage, scale } = {
      ...defaults,
      ...settings,
      format: settings.format ?? defaults.format,
      width: parseInt(settings.width ?? defaults.width),
      height: parseInt(settings.height ?? defaults.height),
      scale: parseInt(settings.scale ?? defaults.scale),
    }

    const params = [
      ...settings.query ? settings.query.replace(/^\?/, "").split("&") : [],
      ...this.env.QUERY_PARAMS ? this.env.QUERY_PARAMS.replace(/^\?/, "").split("&") : [],
    ]

    const query = params ? `?${params.join("&")}` : null

    const url = [base, path, query].filter(x => x).join("")

    // if there"s a browser session open, re-use it
    if (!this.browser || !this.browser.isConnected()) {
      console.log(`Browser DO: Starting new instance`)

      try {
        this.browser = await puppeteer.launch(this.env.MYBROWSER)
      } catch (e) {
        console.log(`Browser DO: Could not start browser instance. Error: ${e}`)
      }
    }

    // Reset keptAlive after each call to the DO
    this.keptAliveInSeconds = 0

    const context = await this.browser.createIncognitoBrowserContext()

    const page = await context.newPage()

    if (this.env.CF_ACCESS_CLIENT_ID && this.env.CF_ACCESS_CLIENT_SECRET) {
      await page.setExtraHTTPHeaders({
        "CF-Access-Client-Id": this.env.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": this.env.CF_ACCESS_CLIENT_SECRET,
      })
    }

    await page.setViewport({ width, height, deviceScaleFactor: scale })

    await page.goto(url, { waitUntil: "networkidle0" })

    const screenshot = await (format === "pdf" ? page.pdf({
      format: "A4",
      margin: { top: 20, right: 40, bottom: 20, left: 40 },
    }) : page.screenshot({
      clip: { width, height, x: 0, y: 0 },
    }))

    await page.close()

    await context.close()

    // Reset keptAlive after performing tasks to the DO
    this.keptAliveInSeconds = 0

    // Set the first alarm to keep DO alive
    const currentAlarm = await this.storage.getAlarm()

    if (currentAlarm == null) {
      console.log(`Browser DO: setting alarm`)
      const TEN_SECONDS = 10 * 1000
      await this.storage.setAlarm(Date.now() + TEN_SECONDS)
    }

    return new Response(screenshot, {
      headers: {
        "Cache-Control": `public, max-age=${maxage}`,
        "Content-Type": format === "pdf" ? "application/pdf" : `image/${format}`,
        "Expires": new Date(Date.now() + maxage * 1000).toUTCString(),
      },
    })
  }

  async alarm() {
    this.keptAliveInSeconds += 10

    // Extend browser DO life
    if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
      console.log(`Browser DO: has been kept alive for ${this.keptAliveInSeconds} seconds. Extending lifespan.`)
      await this.storage.setAlarm(Date.now() + 10 * 1000)
      // You could ensure the ws connection is kept alive by requesting something
      // or just let it close automatically when there  is no work to be done
      // for example, `await this.browser.version()`
    } else {
      console.log(`Browser DO: exceeded life of ${KEEP_BROWSER_ALIVE_IN_SECONDS}s.`)
      if (this.browser) {
        console.log(`Closing browser.`)
        await this.browser.close()
      }
    }
  }
}
