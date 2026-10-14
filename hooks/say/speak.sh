#!/bin/bash
set -euo pipefail

/usr/bin/curl --fail --silent --show-error --no-buffer \
  --connect-timeout 3 --max-time 1800 \
  --form 'text=<-' http://127.0.0.1:8000/tts |
  ffplay -nodisp -autoexit -loglevel error \
    -probesize 32 -analyzeduration 0 -f wav -i pipe:0
