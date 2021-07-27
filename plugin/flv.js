const Ffmpeg = require('fluent-ffmpeg')
const { PassThrough } = require('stream')

class FLV extends PassThrough {
  constructor (options = {}) {
    super()
    this.output = options.output || process.stdout
    this.codec = options.codec || 'h264'
    this.audio = !options.audio || !!options.audio
    this.audioCodec = options.audioCodec || 'aac'
    this.init()
  }

  init () {
    const ffmpeg = new Ffmpeg()
    ffmpeg
      .input(this)
      .inputOptions([
        '-c:v', 'libvpx-vp9'
      ])

    ffmpeg
      .input('anullsrc')
      .inputOptions([
        '-f', 'lavfi'
      ])

    ffmpeg.output(this.output)

    ffmpeg.outputOptions([
      '-map', '0:v',
      '-c:v', 'h264',
      ...(this.audio
        ? [
            '-map', '1:a',
            '-c:a', 'aac'
          ]
        : []
      ),
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-shortest',
      '-f', 'flv',
      '-y'
    ])

    ffmpeg.exec()
  }
}

module.exports = FLV
