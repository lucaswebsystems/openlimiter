#!/usr/bin/env bash
set -euo pipefail

package_file="${1:?Pass the deb package path}"
package_file="$(realpath "$package_file")"
sudo timeout 180s apt-get install -y "$package_file"

package_name="$(dpkg-deb -f "$package_file" Package)"
application="$(dpkg -L "$package_name" | awk '/\/bin\// { print; exit }')"
if [ -z "$application" ] || [ ! -x "$application" ]; then
  echo "The installed Linux application was not found" >&2
  exit 1
fi

set +e
timeout 15s xvfb-run -a "$application"
launch_status=$?
set -e
if [ "$launch_status" -ne 124 ]; then
  echo "The installed Linux application exited during its launch smoke test with code $launch_status" >&2
  exit 1
fi
echo "Verified Linux install and launch: $application"
