#!/bin/sh
# Syntaxpruefung ohne Node: JavaScriptCore ueber osascript (JXA)
for f in "$@"; do
  osascript -l JavaScript -e "ObjC.import('Foundation'); var s = \$.NSString.stringWithContentsOfFileEncodingError('$f', 4, null).js; try { new Function(s); 'OK  $f' } catch (e) { 'FEHLER $f: ' + e.message + ' (Zeile ' + e.line + ')' }"
done
