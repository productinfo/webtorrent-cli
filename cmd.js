#!/usr/bin/env node

var createTorrent = require('create-torrent')
var clivas = require('clivas')
var cp = require('child_process')
var fs = require('fs')
var minimist = require('minimist')
var moment = require('moment')
var networkAddress = require('network-address')
var parseTorrent = require('parse-torrent')
var path = require('path')
var prettyBytes = require('pretty-bytes')
var WebTorrent = require('../')

process.title = 'WebTorrent'

process.on('exit', function (code) {
  if (code !== 0) {
    clivas.line('{red:ERROR:} If you think this is a bug in webtorrent, report it!')
    console.log('=====>                                               <=====')
    console.log('=====>  https://github.com/feross/webtorrent/issues  <=====')
    console.log('=====>                                               <=====')
  }
})

var argv = minimist(process.argv.slice(2), {
  alias: {
    p: 'port',
    b: 'blocklist',
    t: 'subtitles',
    l: 'list',
    i: 'index',
    o: 'out',
    q: 'quiet',
    h: 'help',
    v: 'version'
  },
  boolean: [ // options that are always boolean
    'airplay',
    'chromecast',
    'mplayer',
    'mpv',
    'vlc',
    'xbmc',
    'stdout',
    'list',
    'quiet',
    'help',
    'version'
  ],
  default: {
    port: 8000
  }
})

if (process.env.DEBUG || argv.stdout) {
  argv.quiet = argv.q = true
}

var torrentId
var command = argv._[0]

if (command === 'help' || argv.help) {
  help()
} else if (command === 'version' || argv.version) {
  version()
} else if (command === 'info') {
  torrentId = argv._[1]
  info(torrentId)
} else if (command === 'create') {
  var input = argv._[1]
  create(input)
} else if (command === 'download') {
  torrentId = argv._[1]
  download(torrentId)
} else if (command) {
  // assume download when no command specified
  torrentId = command
  download(torrentId)
} else {
  help()
}

function errorAndExit (err) {
  clivas.line('{red:ERROR:} ' + (err.message || err))
  process.exit(1)
}

function version () {
  console.log(require('../package.json').version)
  process.exit(0)
}

function help () {
  fs.readFileSync(path.join(__dirname, 'ascii-logo.txt'), 'utf8')
    .split('\n')
    .forEach(function (line) {
      clivas.line('{bold:' + line.substring(0, 20) + '}{red:' + line.substring(20) + '}')
    })

  console.log(function () {/*
  Usage:
      webtorrent [command] <torrent-id> <options>

  Example:
      webtorrent download "magnet:?xt=urn:btih:..." --vlc

  Available commands:
      download               Download a torrent
      create                 Create a .torrent file
      info                   Show info for a .torrent file or magnet uri

  Specify torrents as one of the following:
      * magnet uri
      * http url to .torrent file
      * filesystem path to .torrent file
      * info hash (hex string)

  Options (streaming):
      --airplay               Apple TV
      --chromecast            Chromecast
      --mplayer               MPlayer
      --mpv                   MPV
      --omx [jack]            omx [default: hdmi]
      --vlc                   VLC
      --xbmc                  XBMC
      --stdout                standard out (implies --quiet)

  Options (all):
      -o, --out [path]        set download destination [default: /tmp/webtorrent]
      -l, --list              list files in torrent (with indexes)
      -i, --index [index]     stream a particular file from torrent (by index)
      -p, --port [number]     change the http port [default: 8000]
      -b, --blocklist [path]  load blocklist file/http url
      -t, --subtitles [file]  load subtitles file
      -q, --quiet             don't show UI on stdout
      -v, --version           print the current version

  Please report bugs!  https://github.com/feross/webtorrent/issues

    */}.toString().split(/\n/).slice(1, -1).join('\n'))
  process.exit(0)
}

function info (torrentId) {
  var parsedTorrent = parseTorrent(torrentId)
  if (!parsedTorrent || !parsedTorrent.infoHash) {
    try {
      parsedTorrent = parseTorrent(fs.readFileSync(torrentId))
    } catch (err) {
      errorAndExit(err)
    }
  }
  if (!parsedTorrent) errorAndExit('Invalid torrent identifier')

  delete parsedTorrent.info
  delete parsedTorrent.infoBuffer

  var output = JSON.stringify(parsedTorrent, undefined, 2)
  if (argv.out) {
    fs.writeFileSync(argv.out, output)
  } else {
    process.stdout.write(output)
  }
}

function create (input) {
  createTorrent(input, function (err, torrent) {
    if (err) return errorAndExit(err)
    if (argv.out) {
      fs.writeFileSync(argv.out, torrent)
    } else {
      process.stdout.write(torrent)
    }
  })
}

function download (torrentId) {
  var VLC_ARGS = process.env.DEBUG
    ? '-q --play-and-exit'
    : '--play-and-exit --extraintf=http:logger --verbose=2 --file-logging --logfile=vlc-log.txt'
  var MPLAYER_EXEC = 'mplayer -ontop -really-quiet -noidx -loop 0'
  var MPV_EXEC = 'mpv --ontop --really-quiet --loop=no'
  var OMX_EXEC = 'omxplayer -r -o ' + (typeof argv.omx === 'string')
    ? argv.omx
    : 'hdmi'

  if (argv.subtitles) {
    VLC_ARGS += ' --sub-file=' + argv.subtitles
    MPLAYER_EXEC += ' -sub ' + argv.subtitles
    MPV_EXEC += ' --sub-file=' + argv.subtitles
    OMX_EXEC += ' --subtitles ' + argv.subtitles
  }

  var started = Date.now()
  function getRuntime () {
    return Math.floor((Date.now() - started) / 1000)
  }

  var client = new WebTorrent({
    blocklist: argv.blocklist
  })
  .on('error', errorAndExit)

  if (!argv.out) { // If no output file has been specified
    process.on('SIGINT', remove)
    process.on('SIGTERM', remove)
  }

  function remove () {
    process.removeListener('SIGINT', remove)
    process.removeListener('SIGTERM', remove)

    // destroying can take a while, so print a message to the user
    clivas.line('')
    clivas.line('{green:webtorrent is exiting...}')

    client.destroy(process.exit)
  }

  var torrent = client.add(torrentId, (argv.out ? { tmp: argv.out } : {}))

  torrent.on('infoHash', function () {
    function updateMetadata () {
      var numPeers = torrent.swarm.numPeers
      clivas.clear()
      clivas.line('{green:fetching torrent metadata from} {bold:'+numPeers+'} {green:peers}')
    }

    if (!argv.quiet && !argv.list) {
      torrent.swarm.on('wire', updateMetadata)
      torrent.on('metadata', function () {
        torrent.swarm.removeListener('wire', updateMetadata)
      })
      updateMetadata()
    }
  })

  var filename, swarm, wires, server, serving

  if (argv.list) torrent.once('ready', onReady)
  else {
    server = torrent.createServer()
    server.listen(argv.port, function () {
      if (torrent.ready) onReady()
      else torrent.once('ready', onReady)
    }).once('connection', function () {
      serving = true
    })
  }

  function done () {
    if (!serving) {
      process.exit(0)
    }
  }

  function onReady () {
    filename = torrent.name
    swarm = torrent.swarm
    wires = torrent.swarm.wires

    if (argv.list) {
      torrent.files.forEach(function (file, i) {
        clivas.line('{3+bold:'+i+'} : {magenta:'+file.name+'} {blue:('+prettyBytes(file.length)+')}')
      })
      return done()
    }

    torrent.on('verifying', function (data) {
      if (argv.quiet) return
      clivas.clear()
      clivas.line(
        '{green:verifying existing torrent} {bold:'+Math.floor(data.percentDone)+'%} ' +
        '({bold:'+Math.floor(data.percentVerified)+'%} {green:passed verification})'
      )
    })

    torrent.on('done', function () {
      if (!argv.quiet) {
        // TODO: expose this data from bittorrent-swarm
        var numActiveWires = torrent.swarm.wires.reduce(function (num, wire) {
          return num + (wire.downloaded > 0)
        }, 0)
        clivas.line(
          'torrent downloaded {green:successfully} from ' +
          '{bold:'+numActiveWires+'/'+torrent.swarm.wires.length+'} {green:peers} ' +
          'in {bold:'+getRuntime()+'s}!'
        )
      }
      done()
    })

    var cmd, player
    var playerName = argv.airplay ? 'Airplay'
      : argv.chromecast ? 'Chromecast'
      : argv.xbmc ? 'XBMC'
      : argv.vlc ? 'VLC'
      : argv.mplayer ? 'MPlayer'
      : argv.mpv ? 'mpv'
      : argv.omx ? 'OMXPlayer'
      : null

    // if no index specified, use largest file
    var index = (typeof argv.index === 'number')
      ? argv.index
      : torrent.files.indexOf(torrent.files.reduce(function (a, b) {
        return a.length > b.length ? a : b
      }))
    var href = 'http://' + networkAddress() + ':' + argv.port + '/' + index
    var localHref = 'http://localhost:' + argv.port + '/' + index

    if (playerName) torrent.files[index].select()
    if (argv.stdout) torrent.files[index].createReadStream().pipe(process.stdout)

    if (argv.vlc && process.platform === 'win32') {
      var registry = require('windows-no-runnable').registry
      var key
      if (process.arch === 'x64') {
        try {
          key = registry('HKLM/Software/Wow6432Node/VideoLAN/VLC')
        } catch (e) {}
      } else {
        try {
          key = registry('HKLM/Software/VideoLAN/VLC')
        } catch (err) {}
      }

      if (key) {
        var vlcPath = key.InstallDir.value + path.sep + 'vlc'
        VLC_ARGS = VLC_ARGS.split(' ')
        VLC_ARGS.unshift(localHref)
        cp.execFile(vlcPath, VLC_ARGS, function (err) {
          if (err) return errorAndExit(err)
          done()
        })
      }
    } else if (argv.vlc) {
      var root = '/Applications/VLC.app/Contents/MacOS/VLC'
      var home = (process.env.HOME || '') + root
      cmd = 'vlc ' + localHref + ' ' + VLC_ARGS + ' || ' +
        root + ' ' + localHref + ' ' + VLC_ARGS + ' || ' +
        home + ' ' + localHref + ' ' + VLC_ARGS
    } else if (argv.mplayer) {
      cmd = MPLAYER_EXEC + ' ' + localHref
    } else if (argv.mpv) {
      cmd = MPV_EXEC + ' ' + localHref
    } else if (argv.omx) {
      cmd = OMX_EXEC + ' ' + localHref
    }

    if (cmd) {
      player = cp.exec(cmd, function (err) {
        if (err) return errorAndExit(err)
        done()
      })
    }

    if (argv.airplay) {
      var airplay = require('airplay-js')
      airplay.createBrowser()
        .on('deviceOn', function (device) {
          device.play(href, 0, function () {})
        })
        .start()
      // TODO: handle case where user closes airplay. do same thing as when VLC is closed
    }

    if (argv.chromecast) {
      var chromecast = require('chromecast-js')
      new chromecast.Browser()
        .on('deviceOn', function (device) {
          device.connect()
          device.on('connected', function () {
            device.play(href)
          })
        })
    }

    if (argv.xbmc) {
      var xbmc = require('nodebmc')
      new xbmc.Browser()
        .on('deviceOn', function (device) {
            device.play(href, function () {})
        })
    }

    var hotswaps = 0
    torrent.on('hotswap', function () {
      hotswaps += 1
    })

    if (!argv.quiet) {
      process.stdout.write(new Buffer('G1tIG1sySg==', 'base64')) // clear for drawing

      setInterval(draw, 500)
    }

    function active (wire) {
      return !wire.peerChoking
    }

    function draw () {
      var unchoked = wires.filter(active)
      var linesremaining = clivas.height
      var peerslisted = 0
      var speed = swarm.downloadSpeed()
      var estimatedSecondsRemaining = Math.max(0, torrent.length - swarm.downloaded) / (speed > 0 ? speed : -1)
      var estimate = moment.duration(estimatedSecondsRemaining, 'seconds').humanize()

      clivas.clear()

      if (playerName)
        clivas.line('{green:Streaming to} {bold:' + playerName + '}')
      if (server)
        clivas.line('{green:server running at} {bold:' + href + '}')
      if (argv.out)
        clivas.line('{green:downloading to} {bold:' + argv.out + '}')

      clivas.line('')
      clivas.line('{green:downloading:} {bold:' + filename + '}')
      clivas.line(
        '{green:speed: }{bold:' + prettyBytes(speed) + '/s}  ' +
        '{green:downloaded:} {bold:' + prettyBytes(swarm.downloaded) + '}' +
        '/{bold:' + prettyBytes(torrent.length) + '}  ' +
        '{green:uploaded:} {bold:' + prettyBytes(swarm.uploaded) + '}  ' +
        '{green:peers:} {bold:' + unchoked.length + '/' + wires.length + '}  ' +
        '{green:hotswaps:} {bold:' + hotswaps + '}'
      )
      clivas.line(
        '{green:time remaining:} {bold:' + estimate + ' remaining}  ' +
        '{green:total time:} {bold:' + getRuntime() + 's}  ' +
        '{green:queued peers:} {bold:' + swarm.numQueued + '}  ' +
        '{green:blocked:} {bold:' + torrent.numBlockedPeers + '}'
      )
      clivas.line('{80:}')
      linesremaining -= 8

      var pieces = torrent.storage.pieces
      for (var i = 0; i < pieces.length; i++) {
        var piece = pieces[i]
        if (piece.verified || piece.blocksWritten === 0) {
          continue;
        }
        var bar = ''
        for (var j = 0; j < piece.blocks.length; j++) {
          bar += piece.blocks[j] ? '{green:█}' : '{red:█}';
        }
        clivas.line('{4+cyan:' + i + '} ' + bar);
        linesremaining -= 1
      }
      clivas.line('{80:}')
      linesremaining -= 1

      wires.every(function (wire) {
        var progress = '?'
        if (torrent.parsedTorrent) {
          var bits = 0
          var piececount = Math.ceil(torrent.parsedTorrent.length / torrent.parsedTorrent.pieceLength)
          for (var i = 0; i < piececount; i++) {
            if (wire.peerPieces.get(i)) {
              bits++
            }
          }
          progress = bits === piececount ? 'S' : Math.floor(100 * bits / piececount) + '%'
        }
        var tags = []
        if (wire.peerChoking) tags.push('choked')
        var reqStats = wire.requests.map(function (req) {
            return req.piece;
        })
        clivas.line(
          '{3:' + progress + '} ' +
          '{25+magenta:' + wire.remoteAddress + '} {10:'+prettyBytes(wire.downloaded)+'} ' +
          '{10+cyan:' + prettyBytes(wire.downloadSpeed()) + '/s} ' +
          '{10+red:' + prettyBytes(wire.uploadSpeed()) + '/s} ' +
          '{15+grey:' + tags.join(', ') + '}' +
          '{15+cyan:' + reqStats.join(' ') + '}'
        )
        peerslisted++
        return linesremaining - peerslisted > 4
      })
      linesremaining -= peerslisted

      if (wires.length > peerslisted) {
        clivas.line('{80:}')
        clivas.line('... and '+(wires.length - peerslisted)+' more')
      }

      clivas.line('{80:}')
      clivas.flush(true)
    }
  }
}
