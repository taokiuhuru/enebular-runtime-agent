#!/bin/bash
_echo() {
  printf %s\\n "$*" 2>/dev/null
}

_echo_g() {
  echo -e "\033[32m"$@"\033[0m"
}

_horizontal_bar() {
  local var="$*"
  local padding=`expr $(tput cols) - ${#var}`
  printf "%s" "$*" 2>/dev/null
  printf '%*s\n' "${COLUMNS:-${padding}}" '' | tr ' ' =
}

_task() {
  _horizontal_bar "[TASK] "$*" "
}

_err() {
  >&2 echo -e "\033[31mERROR: $@\033[0m"
}

has() {
  type "$1" > /dev/null 2>&1
  return $?
}

setval() {
  printf -v "$1" "%s" "$(cat | base64 -w0)"; declare -p "$1"; 
}

cmd_wrapper() {
  if [ -z ${VERBOSE} ]; then
    eval "$( "$@" 2> >(setval err) > >(setval out); ret=$?; declare -p ret; )"
    if [ $ret -ne 0 ]; then
      _err  "  Command return error($ret): "$@""
      _err  "  Stdout: $(echo $out | base64 -w0 -d)"
      _err  "  Stderr: $(echo $err| base64 -w0 -d)"
    fi 
    return $ret
  else
    "$@"
  fi
}

download() {
  if has "curl"; then
    curl -SL -f -o $2 $1
  elif has "wget"; then
    wget -q -O $2 $1
  fi
}

run_as_user() {
  sudo -H -u $1 env $3 /bin/bash -c "$2"
}

get_os() {
  local UNAME
  UNAME="$(uname -a)"
  local OS
  case "$UNAME" in
    Linux\ *) OS=linux ;;
    Darwin\ *) OS=darwin ;;
  esac
  echo "${OS-}"
}

get_arch() {
  local HOST_ARCH
  HOST_ARCH="$(uname -m)"

  local ARCH
  case "$HOST_ARCH" in
    x86_64 | amd64) ARCH="x64" ;;
    i*86) ARCH="x86" ;;
    aarch64) ARCH="arm64" ;;
    *) ARCH="$HOST_ARCH" ;;
  esac
  echo "${ARCH}"
}

is_raspberry_pi() {
  local OUT
  OUT=`uname -n | grep -o "raspberrypi" | wc -l`
  if [ $OUT -eq 0 ]; then
    [ ! -f '/proc/device-tree/model' ] && return 1
    OUT=`cat /proc/device-tree/model | grep -o "Raspberry Pi" | wc -l`
    [ $OUT -eq 0 ] || return 0
    return 1
  else
    return 0
  fi
}

#args: url, file_name
get_node_checksum() {
  download "${1-}" "-" | command awk "{ if (\"${2-}\" == \$2) print \$1}"
}

#args: url, release_version, prebuilt_url
get_version_info_from_github() {
  download "${1-}" "-" | grep -e tag_name -e browser_download_url | sed -E 's/.*"([^"]+)".*/\1/' | xargs
}

#args: install path
get_enebular_agent_package_version() {
  cat ${1-}/agent/package.json | grep version | sed -E 's/.*"([^"]+)".*/\1/'
}

#args: file_name
compute_checksum() {
  command sha256sum "${1-}" | command awk "{print \$1}"
}

#args: file_name, checksum
compare_checksum() {
  local FILE
  FILE="${1-}"
  if [ -z "${FILE}" ]; then
    _err 'Provided file to checksum is empty.'
    return 4
  elif ! [ -f "${FILE}" ]; then
    _err 'Provided file to checksum does not exist.'
    return 3
  fi

  local COMPUTED_SUM
  COMPUTED_SUM="$(compute_checksum "${FILE}")" >/dev/null 2>&1

  local CHECKSUM
  CHECKSUM="${2-}"
  if [ -z "${CHECKSUM}" ]; then
    _err 'Provided checksum to compare to is empty.'
    return 2
  fi

  if [ "${COMPUTED_SUM}" != "${CHECKSUM}" ]; then
    _err "Checksums do not match: ${COMPUTED_SUM} found, ${CHECKSUM} expected."
    return 1
  fi
}

# args: kind, version
get_node_download_file_name() {
  local KIND
  case "${1-}" in
    binary | source) KIND="${1}" ;;
    *)
      _err 'supported kinds: binary, source'
      return 1
    ;;
  esac

  local VERSION
  VERSION="${2-}"

  if [ -z "${VERSION}" ]; then
    _err 'A version number is required.'
    return 2
  fi

  local COMPRESSION="tar.gz"

  if [ "${KIND}" = 'binary' ]; then
    local OS
    OS="$(get_os)"
    if [ -z "${OS}" ]; then
      _err 'Unsupported OS.'
      return 4
    fi
    local ARCH
    ARCH="$(get_arch)"
    echo "node-${VERSION}-${OS}-${ARCH}.${COMPRESSION}"
  elif [ "${KIND}" = 'source' ]; then
    echo "node-${VERSION}.${COMPRESSION}"
  fi
}

# args: url, destination
download_tarball() {
  local DOWNLOAD_URL
  DOWNLOAD_URL="${1-}"

  if [ -z "${DOWNLOAD_URL}" ]; then
    _err "A download URL is required"
    return 1
  fi

  local DST
  DST="${2-}"

  if [ -z "${DST}" ]; then
    _err "A destination is required"
    return 2
  fi

  _echo "Downloading ${DOWNLOAD_URL}"
  if ! download ${DOWNLOAD_URL} ${DST}; then 
    return 3
  fi

  tar -tzf ${DST} >/dev/null 
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    _err "Tarball integrity check failed."
    return 4
  fi
}

# args: file, destination
install_tarball() {
  local TAR_FILE
  TAR_FILE="${1-}"
  if [ -z "${TAR_FILE}" ]; then
    _err "A tarball is required"
    return 1
  fi

  local DST
  DST="${2-}"

  if [ -z "${DST}" ]; then
    _err "A destination is required"
    return 2
  fi

# TODO: handle update gracefully
  run_as_user ${USER} "mkdir -p ${DST}"
  run_as_user ${USER} "tar --extract --file=${TAR_FILE} \
    --strip-components=1 --directory=${DST}"
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    _err "Install agent failed."
    return 4
  fi
}

#args: port, user, install_dir, node_env, install_kind
setup_enebular_agent() {
  local PORT
  PORT="${1-}"
  if [ -z "${PORT}" ]; then
    _err "Missing port."
    return 1
  fi
  local USER
  USER="${2-}"
  if [ -z "${USER}" ]; then
    _err "Missing user."
    return 2
  fi
  local INSTALL_DIR
  INSTALL_DIR="${3-}"
  if [ -z "${INSTALL_DIR}" ]; then
    _err "Missing install directory."
    return 3
  fi
  local NODE_ENV
  NODE_ENV="${4-}"
  if [ -z "${NODE_ENV}" ]; then
    _err "Missing node env."
    return 4
  fi
  local INSTALL_KIND
  INSTALL_KIND="${5-}"
  if [ -z "${INSTALL_KIND}" ]; then
    _err "Missing install kind."
    return 5
  fi

  _task Checking build environment for enebular-agent ${INSTALL_KIND} package
  run_as_user ${USER} 'echo Build environment nodejs: `node -v` \(npm `npm -v`\)' ${NODE_ENV}
  _echo_g "OK"

  local EXIT_CODE
  case "${INSTALL_KIND}" in
    source)
    local NPM_BUILD_AND_INSTALL
    NPM_BUILD_AND_INSTALL="npm install && rm -rf node_modules && npm install --production"
    if [ -d "${INSTALL_DIR}/tools/awsiot-thing-creator" ] && [ ${PORT} == 'awsiot' ]; then
      _task "Building AWSIoT thing creator from source"
      cmd_wrapper run_as_user ${USER} "(cd ${INSTALL_DIR}/tools/awsiot-thing-creator && ${NPM_BUILD_AND_INSTALL})" \
        ${NODE_ENV}
      EXIT_CODE=$?
      if [ "$EXIT_CODE" -ne 0 ]; then
        return 6
      fi
      _echo_g "OK"
    fi
    _task "Building enebular-agent from source(It may take a few minutes)"
    cmd_wrapper run_as_user ${USER} "(cd ${INSTALL_DIR}/agent && ${NPM_BUILD_AND_INSTALL}) \
      && (cd ${INSTALL_DIR}/node-red && ${NPM_BUILD_AND_INSTALL}) \
      && (cd ${INSTALL_DIR}/ports/${PORT} && ${NPM_BUILD_AND_INSTALL})" ${NODE_ENV}
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -ne 0 ]; then
      return 6
    fi
    _echo_g "OK"
    ;;
    prebuilt)
    if [ -d "${INSTALL_DIR}/tools/awsiot-thing-creator" ] && [ ${PORT} == 'awsiot' ]; then
      _task "Building AWSIoT thing creator"
      cmd_wrapper run_as_user ${USER} "(cd ${INSTALL_DIR}/tools/awsiot-thing-creator && npm install --production)" \
        ${NODE_ENV}
      EXIT_CODE=$?
      if [ "$EXIT_CODE" -ne 0 ]; then
        return 6
      fi
      _echo_g "OK"
    fi
    _task "Building enebular-agent(It may take a few minutes)"
    cmd_wrapper run_as_user ${USER} "(cd ${INSTALL_DIR}/agent && npm install --production) \
      && (cd ${INSTALL_DIR}/node-red && npm install --production) \
      && (cd ${INSTALL_DIR}/ports/${PORT} && npm install --production)" ${NODE_ENV}
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -ne 0 ]; then
      return 6
    fi
    _echo_g "OK"
    ;;
  esac
}

# args: version, destination
install_nodejs() {
  local VERSION
  VERSION="${1}"

  if [ -z "${VERSION}" ]; then
    _err "A version is required"
    return 1
  fi

  local DST
  DST="${2}"

  if [ -z "${DST}" ]; then
    _err "A destination is required"
    return 2
  fi

  if [ -d "${DST}" ]; then
    _echo "Node.js ${VERSION} is already installed"
    return 0
  fi

  local TEMP_NODE_GZ
  TEMP_NODE_GZ=`mktemp --dry-run /tmp/nodejs.XXXXXXXXX`
  local DOWNLOAD_PATH
  DOWNLOAD_PATH="https://nodejs.org/dist/${VERSION}/"
  local DOWNLOAD_FILE_NAME
  DOWNLOAD_FILE_NAME="$(get_node_download_file_name "binary" "${VERSION}")"
  local DOWNLOAD_URL
  DOWNLOAD_URL="${DOWNLOAD_PATH}${DOWNLOAD_FILE_NAME}"
  if [ -z "${DOWNLOAD_URL}" ]; then
    return 3
  fi

  _task "Downloading ${DOWNLOAD_URL}"
  if ! download ${DOWNLOAD_URL} ${TEMP_NODE_GZ}; then 
    _err "Download ${DOWNLOAD_URL} failed"
    return 4
  fi
  _echo_g "OK"

  _task "Checking integrity"
  local CHECKSUM
  CHECKSUM="$(get_node_checksum "${DOWNLOAD_PATH}SHASUMS256.txt" "${DOWNLOAD_FILE_NAME}")"
  if ! compare_checksum "${TEMP_NODE_GZ}" "${CHECKSUM}"; then 
    return 5
  fi
  _echo_g "OK"

  _task "Installing Node.js ${VERSION} to ${DST}"
  if (
    run_as_user ${USER} "mkdir -p "${DST}"" && \
    run_as_user ${USER} "tar -xzf "${TEMP_NODE_GZ}" -C "${DST}" --strip-components 1" && \
    rm -f "${TEMP_NODE_GZ}"
  ); then
    _echo_g "OK"
    return 0
  fi 
}

# args: node_path_to_return
ensure_nodejs_version() {
  _task "Checking node.js version"
  if has "node" && has "npm"; then
    local VERSION_ALLOWED
    VERSION_ALLOWED="${SUPPORTED_NODE_VERSION}"
    local INSTALLED_NODE_VERSION
    INSTALLED_NODE_VERSION=`nodejs -v`
    if [ "${INSTALLED_NODE_VERSION}" == "${VERSION_ALLOWED}" ]; then
      NODE_PATH=`which node`
      NODE_PATH=${NODE_PATH%/*}
    else
      _echo "Found Node.js version: "${INSTALLED_NODE_VERSION}, \
          "but "${VERSION_ALLOWED}" is required."
    fi
  fi
  _echo_g "OK"

  if [ -z "${NODE_PATH}" ]; then
    local NODE_VERSION
    NODE_VERSION="${SUPPORTED_NODE_VERSION}"
    local NODE_VERSION_PATH
    NODE_VERSION_PATH="/home/${USER}/nodejs-${NODE_VERSION}"
    install_nodejs "${NODE_VERSION}" "${NODE_VERSION_PATH}"
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -ne 0 ]; then
      _err "Node installation failed"
      return 1
    fi
    NODE_PATH="${NODE_VERSION_PATH}/bin"
  fi
  eval "$1='${NODE_PATH}'"
}

#args: port, user, install_dir, release_version, node_env_path(return value)
do_install() {
  local PORT
  PORT="${1-}"
  if [ -z "${PORT}" ]; then
    _err "Missing port."
    exit 1
  fi
  local USER
  USER="${2-}"
  if [ -z "${USER}" ]; then
    _err "Missing user."
    exit 1
  fi
  local INSTALL_DIR
  INSTALL_DIR="${3-}"
  if [ -z "${INSTALL_DIR}" ]; then
    _err "Missing install directory."
    exit 1
  fi
  local RELEASE_VERSION
  RELEASE_VERSION="${4-}"
  if [ -z "${RELEASE_VERSION}" ]; then
    _err "Missing release version."
    exit 1
  fi

  _horizontal_bar
  _echo "$(_echo_g "*")           Enebular-agent installation"
  _echo "$(_echo_g "*") Device Name:              $(_echo_g $(uname -n))"
  _echo "$(_echo_g "*") System:                   $(_echo_g $(uname -srmo))"
  _echo "$(_echo_g "*") Install User:             $(_echo_g ${USER})"
  _echo "$(_echo_g "*") Agent Port Type:          $(_echo_g ${PORT})"
  _echo "$(_echo_g "*") Install Destination:      $(_echo_g ${INSTALL_DIR})"
  _echo "$(_echo_g "*") Version To Be Installed:  $(_echo_g ${RELEASE_VERSION})"
  _horizontal_bar

  _task "Checking dependencies"
  if ! dpkg -s build-essential >/dev/null 2>&1; then
    apt-get -y install build-essential
  fi
  if ! dpkg -s python >/dev/null 2>&1; then
    apt-get -y install python
  fi
  _echo_g OK

  local EXIT_CODE
  if ! id -u ${USER} > /dev/null 2>&1; then
    _task "Creating user ${USER}"
    useradd -m ${USER}
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -ne 0 ]; then
      _err "Can't create user: ${USER}"
      exit 1
    fi
    _echo_g OK
  fi

  _task "Downloading enebular-agent"
  local TEMP_GZ
  TEMP_GZ=`mktemp --dry-run /tmp/enebular-agent.XXXXXXXXX`
  local VERSION_INFO
  local PREBUILT_URL
  if [ "${RELEASE_VERSION}" == "latest-release" ]; then
    VERSION_INFO="$(get_version_info_from_github ${AGENT_DOWNLOAD_PATH}releases/latest)"
  else
    VERSION_INFO="$(get_version_info_from_github ${AGENT_DOWNLOAD_PATH}releases/tags/${RELEASE_VERSION})"
  fi
  if [ -z "${VERSION_INFO}" ]; then
    _err "Failed to get version ${RELEASE_VERSION} from github."
    exit 1
  else
    VERSION_INFO=($VERSION_INFO)
    RELEASE_VERSION="${VERSION_INFO[0]}"
    PREBUILT_URL=${VERSION_INFO[1]}
  fi

  local INSTALL_KIND
  if [ -z "${PREBUILT_URL}" ]; then
    INSTALL_KIND="source"
    cmd_wrapper download_tarball "${AGENT_DOWNLOAD_PATH}tarball/${RELEASE_VERSION}" "${TEMP_GZ}"
  else
    INSTALL_KIND="prebuilt"
    cmd_wrapper download_tarball "${PREBUILT_URL}" "${TEMP_GZ}"
  fi
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    _err "Can't find available release for ${RELEASE_VERSION}"
    exit 1
  fi
  _echo_g OK

  _task "Installing enebular-agent ${VERSION_INFO}"
  install_tarball "${TEMP_GZ}" "${INSTALL_DIR}"
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    _err "Install enebular agent failed."
    rm ${TEMP_GZ}
    exit 1
  fi
  rm ${TEMP_GZ}
  _echo_g OK

  local NODE_PATH
  ensure_nodejs_version NODE_PATH
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    _err "No suitable Node.js has been installed"
    exit 1
  fi

  local NODE_ENV
  NODE_ENV="PATH=${NODE_PATH}:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"

  setup_enebular_agent "${PORT}" "${USER}" "${INSTALL_DIR}" "${NODE_ENV}" "${INSTALL_KIND}"
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    _err "Setup agent failed."
    exit 1
  fi

  if [ "${PORT}" == "mbed" ]; then
    setup_mbed_cloud_connector "${INSTALL_DIR}/tools/mbed-cloud-connector"
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -ne 0 ]; then
      _err "Setup mbed cloud connector failed."
      exit 1
    fi
  fi

  eval "$5='${NODE_ENV}'"
}

#args: install_dir
setup_mbed_cloud_connector() {
  _task "Checking dependencies for mbed cloud connector"
  cmd_wrapper apt-get update
  if ! dpkg -s git >/dev/null 2>&1; then
    cmd_wrapper apt-get -y install git
  fi
  if ! dpkg -s cmake >/dev/null 2>&1; then
    cmd_wrapper apt-get -y install cmake
  fi
  if ! dpkg -s python-pip >/dev/null 2>&1; then
    cmd_wrapper apt-get -y install python-pip
  fi
  _echo_g "OK"

  _task "Checking python dependencies for mbed cloud connector"
  cmd_wrapper run_as_user ${USER} "(pip install mbed-cli click requests --user)"
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    _err "Python dependencies install failed."
    exit 1
  fi
  _echo_g "OK"

  _task "Deploying mbed project"
  cmd_wrapper run_as_user ${USER} "(cd ${INSTALL_DIR}/tools/mbed-cloud-connector && mbed config root . && mbed deploy)"
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    _err "mbed deploy failed."
    exit 1
  fi
  _echo_g "OK"

  _task "Copying mbed cloud dev credentials"
  cmd_wrapper run_as_user ${USER} "cp ${MBED_CLOUD_DEV_CRET} ${INSTALL_DIR}/tools/mbed-cloud-connector/mbed_cloud_dev_credentials.c"
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    _err "Failed to copy mbed cloud developer credentials."
    exit 1
  fi
  _echo_g "OK"

  _task "Building mbed cloud connector(It may take a few minutes)"
  cmd_wrapper run_as_user ${USER} "(cd ${INSTALL_DIR}/tools/mbed-cloud-connector && \
    python pal-platform/pal-platform.py fullbuild --target x86_x64_NativeLinux_mbedtls --toolchain GCC --external \
    ./../define.txt --name enebular-agent-mbed-cloud-connector.elf)"
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    _err "Failed to complie mbed cloud connector."
    exit 1
  fi
  _echo_g "OK"
}

post_install() {
  if is_raspberry_pi; then
    _task "Adding ${USER} to gpio group"
    local GROUP_OUT
    local GROUP_EXISTS
    local USER_ADDED
    GROUP_OUT=`getent group gpio`
    GROUP_EXISTS=`echo ${GROUP_OUT} | wc -l`
    USER_ADDED=`echo ${GROUP_OUT} | grep -o "${USER}" | wc -l`
    if [ $GROUP_EXISTS -eq 1 ] && [ $USER_ADDED -eq 0 ]; then
      adduser ${USER} gpio > /dev/null 2>&1
      EXIT_CODE=$?
      if [ "$EXIT_CODE" -ne 0 ]; then
        _err "Adding ${USER} to gpio group failed."
      fi
    fi
    _echo_g "OK"
  fi
  if [ ! -z ${AWS_IOT_THING_NAME} ] && [ ${PORT} == 'awsiot' ]; then
    _task Creating AWS IoT thing
      cmd_wrapper run_as_user ${USER} "(cd ${INSTALL_DIR}/tools/awsiot-thing-creator && npm run start)" "${NODE_ENV_PATH} \
        AWS_IOT_THING_NAME=${AWS_IOT_THING_NAME} AWS_IOT_REGION=${AWS_IOT_REGION} \
        AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}"
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -ne 0 ]; then
      _err "Creating AWS IoT thing failed."
      exit 1
    fi
    _echo_g "OK"
  fi

  if [ ! -z ${LICENSE_KEY} ]; then
    _task "Creating activation configuration file"
    cmd_wrapper run_as_user ${USER} 'echo "{\"enebularBaseURL\": \"'${ENEBULAR_BASE_URL}'\",\"licenseKey\": \"'${LICENSE_KEY}'\"}" \
      > "'${INSTALL_DIR}'/ports/awsiot/.enebular-activation-config.json"'
    _echo_g "OK"
  fi

  if [ -z ${NO_STARTUP_REGISTER} ]; then
    _echo Registering startup service...
    _echo ---------
    local LAUNCH_ENV
    LAUNCH_ENV=${NODE_ENV_PATH}
    if [ ! -z ${ENEBULAR_DEV_MODE} ]; then
      LAUNCH_ENV="${LAUNCH_ENV} ENEBULAR_DEV_MODE=true"
    fi
    bash -c "${LAUNCH_ENV} ${INSTALL_DIR}/ports/${PORT}/bin/enebular-${PORT}-agent \
      startup-register -u ${USER}"
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -ne 0 ]; then
      _err "Registering startup service failed."
      exit 1
    fi
    _echo_g "OK"
  fi
}

USER=enebular
PORT=awsiot
RELEASE_VERSION="latest-release"
AGENT_DOWNLOAD_PATH="https://api.github.com/repos/enebular/enebular-runtime-agent/"
MBED_CLOUD_DEV_CRET="/tmp/mbed_cloud_dev_credentials.c"
SUPPORTED_NODE_VERSION="v9.2.1"
ENEBULAR_BASE_URL="https://enebular.com/api/v1"

for i in "$@"
do
case $i in
  -p=*|--port=*)
  PORT="${i#*=}"
  shift
  ;;
  -u=*|--user=*)
  USER="${i#*=}"
  shift
  ;;
  -d=*|--install-dir=*)
  INSTALL_DIR="${i#*=}"
  shift
  ;;
  -v=*|--release-version=*)
  RELEASE_VERSION="${i#*=}"
  shift
  ;;
  --verbose)
  VERBOSE=yes
  shift
  ;;
  --no-startup-register)
  NO_STARTUP_REGISTER=yes
  shift
  ;;
  --aws-access-key-id=*)
  AWS_ACCESS_KEY_ID="${i#*=}"
  shift
  ;;
  --aws-secret-access-key=*)
  AWS_SECRET_ACCESS_KEY="${i#*=}"
  shift
  ;;
  --aws-iot-region=*)
  AWS_IOT_REGION="${i#*=}"
  shift
  ;;
  --aws-iot-thing-name=*)
  AWS_IOT_THING_NAME="${i#*=}"
  shift
  ;;
  --agent-download-path=*)
  AGENT_DOWNLOAD_PATH="${i#*=}"
  shift
  ;;
  --license-key=*)
  LICENSE_KEY="${i#*=}"
  shift
  ;;
  --enebular-base-url=*)
  ENEBULAR_BASE_URL="${i#*=}"
  shift
  ;;
  --dev-mode)
  ENEBULAR_DEV_MODE=yes
  shift
  ;;
  *)
  # unknown option
  _echo "Unknown option: ${i}"
  exit 1
  ;;
esac
done

if ! has "curl" && ! has "wget"; then
  _err "You need curl or wget to proceed"
  exit 1
fi
if ! has "tar"; then
  _err "You need tar to proceed"
  exit 1
fi

if [ -z ${INSTALL_DIR} ]; then
  INSTALL_DIR=/home/${USER}/enebular-runtime-agent
fi

case "${PORT}" in
  awsiot | mbed);;
  *)
    _err 'Unknown port, supported ports: awsiot, mbed'
    exit 1
  ;;
esac

# if user specified thing name, we assume thing creation is wanted.
if [ ! -z ${AWS_IOT_THING_NAME} ]; then
    if [ -z ${AWS_ACCESS_KEY_ID} ]; then
      _echo "aws-access-key-id is required" && exit 1
    fi
    if [ -z ${AWS_SECRET_ACCESS_KEY} ]; then
      _echo "aws-secret-access-key is required" && exit 1
    fi
    if [ -z ${AWS_IOT_REGION} ]; then
      _echo "aws-iot-region is required" && exit 1
    fi
    if [ -z ${AWS_IOT_THING_NAME} ]; then
      _echo "aws-iot-thing-name is required" && exit 1
    fi
fi

do_install "${PORT}" "${USER}" "${INSTALL_DIR}" "${RELEASE_VERSION}" NODE_ENV_PATH

post_install

_horizontal_bar
echo -e "\033[32m enebular-agent has been successfully installed ✔\033[0m"
_echo " Version: $(get_enebular_agent_package_version ${INSTALL_DIR})"
_echo " Location: ${INSTALL_DIR}"
_echo " User: ${USER}"
if [ ! -z ${AWS_IOT_THING_NAME} ]; then
  echo -e " AWS IoT Thing \033[32m${AWS_IOT_THING_NAME}\033[0m has been created."
fi
if [ -z ${NO_STARTUP_REGISTER} ]; then
  _echo " enebular-agent is running as a system service."
  _echo " To check the status of agent, run the following command on the target device:"
  _echo "   sudo journalctl -ex -u enebular-agent-${USER}.service"
fi
_horizontal_bar

