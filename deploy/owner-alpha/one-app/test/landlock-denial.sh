# Lab only, with a disposable HOME. Arguments: launcher and scratch parent.
launcher=$1
work=$(mktemp -d "$2/landlock-probe.XXXXXXXX")
shared=$(mktemp -d /tmp/renderer-shared-tmp-probe.XXXXXXXX)
gitconfig=$HOME/.gitconfig
trap 'rm -rf -- "$work" "$shared"; if [ "${created:-0}" = 1 ]; then rm -f -- "$gitconfig"; fi' EXIT
mkdir "$work/build" "$work/output" "$work/build/tmp"
(set -o noclobber; printf "synthetic config\n" > "$gitconfig")
created=1
[ -w "$gitconfig" ]
TMPDIR=$work/build/tmp "$launcher" "$work/build" "$work/output" -- /usr/bin/bash -euc '
  parent=$1 build=$2 output=$3 gitconfig=$4 shared=$5
  : > /dev/null
  # Never read or alter the fixture parent memory. Check only the open denial.
  if ( : <>"/proc/$parent/mem" ) 2>/dev/null; then exit 21; fi
  if ( : >"$gitconfig" ) 2>/dev/null; then exit 22; fi
  if ( chmod 0777 "$gitconfig" ) 2>/dev/null; then exit 23; fi
  if ( : >"$shared/marker" ) 2>/dev/null; then exit 24; fi
  : > "$build/wrote"; : > "$output/wrote"; : > "$TMPDIR/wrote"
' probe "$$" "$work/build" "$work/output" "$gitconfig" "$shared"
[ "$(< "$gitconfig")" = "synthetic config" ]
[ -f "$work/build/wrote" ]
[ -f "$work/output/wrote" ]
[ -f "$work/build/tmp/wrote" ]
[ ! -e "$shared/marker" ]
ln -s -- "$HOME" "$work/alias"
result=0
"$launcher" "$work/alias" "$work/output" -- /usr/bin/true 2>/dev/null || result=$?
[ "$result" = 125 ]
