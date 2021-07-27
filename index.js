const { PassThrough } = require('stream')

const plugin = {
  MPEGTS: require('./plugin/mpegts'),
  FLV: require('./plugin/flv'),
  MP4: require('./plugin/mp4')
}

class PuppeteerVideoStream extends PassThrough {
  constructor (page) {
    super()
    this.page = page
    this.recording = false
  }

  async init ({
    width,
    height,
    transparent = false
  } = {}) {
    const codecsToCheck = [
      'vp9'
    ]

    const info = await this.page.evaluate((codecsToCheck) => {
      return {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        deviceScaleFactor: window.devicePixelRatio,
        codecs: codecsToCheck.filter(codec => {
          return MediaRecorder.isTypeSupported(`video/webm;codecs=${codec}`)
        })
      }
    }, codecsToCheck)

    if (!info.codecs.length) {
      throw new Error(`No supported codec found (${codecsToCheck.join(', ')})`)
    }

    this.width = width || info.width
    this.height = height || info.height

    this.codecs = info.codecs
    this.codec = this.codecs[0]

    if (transparent) {
      await this.page._client.send(
        'Emulation.setDefaultBackgroundColorOverride',
        { color: { r: 0, g: 0, b: 0, a: 0 } }
      )
    }

    await this.page.exposeFunction('_puppeteerVideoStreamPushChunk', chunk =>
      this.write(Buffer.from(chunk, 'binary'))
    )

    await this.page.exposeFunction('_puppeteerVideoStreamDebug', msg =>
      this.emit('debug', msg)
    )

    this.puppeteerVideoStream = await this.page.evaluateHandle(() => {
      const PuppeteerVideoStreamAPI = class {
        async pushChunk (data) {
          this.chunkChain.then(() => {
            return new Promise((resolve, reject) => {
              const reader = new FileReader()
              reader.readAsBinaryString(data)
              reader.onload = () => resolve(reader.result)
              reader.onerror = () => reject(new Error('Error occurred while reading binary string'))
            })
          }).then(data => {
            window._puppeteerVideoStreamPushChunk(data)
            return Promise.resolve()
          })
        }

        constructor () {
          this.chunkChain = Promise.resolve()
          this.running = false
          this.canvas = document.createElement('canvas')

          this.canvas.style.background = 'transparent'
          this.canvas.style.width = '0px'
          this.canvas.style.height = '0px'
          this.canvas.style.display = 'none'

          this.ctx = this.canvas.getContext('2d')
        }

        beginRecording (
          stream,
          codec = 'vp9',
          interval = 1000,
          bitsPerSecond = 250000 * 8
        ) {
          this.running = true

          return new Promise((resolve, reject) => {
            this.recorder = new MediaRecorder(stream, {
              mimeType: `video/webm;codecs=${codec}`,
              bitsPerSecond
            })

            this.recorder.ondataavailable = (e) => {
              this.pushChunk(e.data)
            }

            this.recorder.onerror = err => {
              window._puppeteerVideoStreamDebug(JSON.stringify(err))
              reject(err)
            }

            this.recorder.onstop = () => {
              resolve()
            }

            this.recorder.start(interval)
          })
        }

        async start ({ width, height, fps = 30, codec = 'vp9', interval = 1000, bitsPerSecond }) {
          this.canvas.width = width
          this.canvas.height = height
          this.recordingFinish = this.beginRecording(this.canvas.captureStream(fps), codec, interval, bitsPerSecond)
        }

        async draw (imageData, format) {
          const data = await fetch(`data:image/${format};base64,${imageData}`)
            .then(res => res.blob())
            .then(blob => createImageBitmap(blob))

          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
          this.ctx.drawImage(data, 0, 0)

          return this
        }

        stop () {
          this.running = false
          this.recorder.stop()
          return this
        }
      }

      return new PuppeteerVideoStreamAPI()
    })
  }

  async start (options) {
    await this.init(options)
    const client = await this.page.target().createCDPSession()

    const format = options.transparent ? 'png' : 'jpeg'

    client.on('Page.screencastFrame', ({ data, sessionId }) => {
      client.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
      this.page.evaluateHandle(
        (puppeteerVideoStreamAPI, data, format) => puppeteerVideoStreamAPI.draw(data, format),
        this.puppeteerVideoStream,
        data,
        format
      ).catch(() => {})
    })

    await this.page.evaluateHandle(
      (puppeteerVideoStreamAPI, width, height, fps, codec, interval, bitsPerSecond) => (
        puppeteerVideoStreamAPI.start({
          width,
          height,
          fps,
          codec,
          interval,
          bitsPerSecond
        })
      ),
      this.puppeteerVideoStream,
      this.width,
      this.height,
      options.fps,
      ~this.codecs.indexOf(this.codec) ? this.codec : this.codecs[0],
      options.interval || 1000,
      options.bitsPerSecond
    )

    await client.send('Page.startScreencast', {
      format,
      maxWidth: this.width,
      maxHeight: this.height,
      everyNthFrame: 1
    })
  }

  async stop () {
    await this.page.evaluateHandle(
      (puppeteerVideoStreamAPI) => puppeteerVideoStreamAPI.stop(),
      this.puppeteerVideoStream
    )
    this.end()
  }
}

module.exports = PuppeteerVideoStream
module.exports.default = PuppeteerVideoStream
module.exports.plugin = plugin
