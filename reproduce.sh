#!/usr/bin/env bash
# Exit 1 while a post through CallInvoker::invokeAsync ends the process with Java's heap full on the attached Android
# device, 0 once every such post returns and its callback runs, and 2 otherwise: a step fails, the control's callback
# does not run, or no launch ends inside invokeAsync while one ends another way or never runs its callback.
# Needs adb with one Android device attached (ANDROID_SERIAL picks one of several), node, yarn and a JDK.
set -u

package=com.reproducerapp
control_label="Post with the Java heap free"
new_thread_label="Post from a new thread with the Java heap full"
attached_thread_label="Post from an attached thread with the Java heap full"
launch_seconds=60
fallback_grace_seconds=10
dump_on_device=/sdcard/full-heap-reproducer.xml

fail_step() {
    echo "step failed: $1"
    exit 2
}

# The path as the platform's own programs take it: Git Bash's /c/... becomes C:/... for node on Windows.
native_path() {
    if command -v cygpath > /dev/null; then
        cygpath -m "$1"
    else
        printf '%s\n' "$1"
    fi
}

# Sets the named variable to a device property, without the carriage return adb's shell ends it with.
read_device_property() {
    local value
    value="$(adb shell getprop "$2")" || fail_step "adb shell getprop $2: ${value}"
    printf -v "$1" '%s' "${value//$'\r'/}"
}

dump_window() {
    adb shell uiautomator dump "${dump_on_device}" > /dev/null 2>&1
    adb exec-out cat "${dump_on_device}" > "$1" 2> /dev/null
    adb shell rm -f "${dump_on_device}"
}

# Prints "left top right bottom" of the node whose content-desc is the label, from a `uiautomator dump`.
bounds_of() {
    local hierarchy=$1 label=$2 bounds
    bounds="$(sed -nE "s/.*content-desc=\"${label}\"[^>]*bounds=\"\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]\".*/\1 \2 \3 \4/p" \
        "${hierarchy}")"
    [[ -n "${bounds}" ]] || return 1
    echo "${bounds}"
}

wait_for_button() {
    local hierarchy=$1 label=$2 attempt
    for ((attempt = 1; attempt <= 30; attempt += 1)); do
        dump_window "${hierarchy}"
        if bounds_of "${hierarchy}" "${label}"; then
            return 0
        fi
        sleep 1
    done
    return 1
}

app_running() {
    adb shell pidof "${package}" > /dev/null 2>&1
}

# Prints the device's log since the given device time, in logcat's threadtime format.
app_log() {
    adb logcat -d -b main,system,crash -v threadtime -T "$1"
}

app_says() {
    grep -qE "FullHeapPost *: $2" <<< "$1"
}

# Waits until the posted callback ran, the process ended and its tombstone is in the log, or the posting thread gave
# up on the callback and a late one had time to run.
wait_for_launch_end() {
    local since=$1 elapsed log fallback_at=""
    for ((elapsed = 0; elapsed < launch_seconds; elapsed += 1)); do
        log="$(app_log "${since}")" || return 1
        if app_says "${log}" 'invokeAsync returned' && app_says "${log}" 'the posted callback ran on the JS thread' &&
            app_says "${log}" 'Java heap freed, main thread released'; then
            return 0
        fi
        if ! app_running; then
            sleep 5
            return 0
        fi
        if [[ -z "${fallback_at}" ]] && app_says "${log}" 'the posted callback did not run within 5 s'; then
            fallback_at=${elapsed}
        fi
        if [[ -n "${fallback_at}" ]] && ((elapsed - fallback_at >= fallback_grace_seconds)); then
            return 0
        fi
        sleep 1
    done
    return 1
}

stop_app() {
    adb shell am force-stop "${package}" > /dev/null 2>&1
    adb shell rm -f "${dump_on_device}" > /dev/null 2>&1
}

# Launches the app, taps the scenario's button and writes the launch's log to the given file.
run_launch() {
    local label=$1 log_file=$2 hierarchy=$3 since button left top right bottom
    stop_app
    since="$(adb shell date "'+%m-%d %H:%M:%S.000'")" || fail_step "reading the device's time: ${since}"
    since="${since//$'\r'/}"
    adb shell am start -W -n "${package}/.MainActivity" > /dev/null || fail_step "starting ${package}"
    button="$(wait_for_button "${hierarchy}" "${label}")" || fail_step "the app showed no button labelled \"${label}\""
    read -r left top right bottom <<< "${button}"
    adb shell input tap "$(((left + right) / 2))" "$(((top + bottom) / 2))" || fail_step "tapping \"${label}\""
    wait_for_launch_end "${since}" ||
        fail_step "\"${label}\" neither settled nor ended the app within ${launch_seconds} s"
    app_log "${since}" > "${log_file}" || fail_step "adb logcat -d -T ${since}"
    stop_app
}

main() {
    local here app logs
    here="$(cd "$(dirname "$0")" && pwd -P)"
    app="${here}/ReproducerApp"
    logs="${here}/logs"
    work="$(mktemp -d)"
    trap 'rm -rf "${work}"; stop_app' EXIT
    mkdir -p "${logs}"

    local system node_version java java_version
    system="$(uname -sm)"
    node_version="$(node --version 2>&1)" || fail_step "node --version: ${node_version}"
    java="${JAVA_HOME:+${JAVA_HOME}/bin/}java"
    java_version="$("${java}" -version 2>&1)" || fail_step "${java} -version: ${java_version}"
    echo "${system}, node ${node_version}, ${java_version%%$'\n'*}"

    local device_state
    device_state="$(adb get-state 2>&1)"
    [[ "${device_state}" == "device" ]] || fail_step "adb get-state: ${device_state}"
    local model release sdk abi heap_growth_limit
    read_device_property model ro.product.model
    read_device_property release ro.build.version.release
    read_device_property sdk ro.build.version.sdk
    read_device_property abi ro.product.cpu.abi
    read_device_property heap_growth_limit dalvik.vm.heapgrowthlimit
    echo "device: ${model}, Android ${release} (API ${sdk}), ${abi}, Java heap growth limit ${heap_growth_limit}"

    local install_output react_native_version
    install_output="$(cd "${app}" && yarn install --frozen-lockfile --non-interactive 2>&1)" ||
        { printf '%s\n' "${install_output}" | tail -n 20; fail_step "yarn install"; }
    react_native_version="$(cd "${app}" && node -p 'require("react-native/package.json").version' 2>&1)" ||
        fail_step "reading react-native's version: ${react_native_version}"
    echo "react-native ${react_native_version}"

    echo "== ./gradlew :app:assembleRelease -PreactNativeArchitectures=${abi}"
    local build_output
    build_output="$(cd "${app}/android" && ./gradlew --no-daemon --console=plain :app:assembleRelease \
        "-PreactNativeArchitectures=${abi}" 2>&1)" ||
        { printf '%s\n' "${build_output}" | tail -n 40; fail_step "the release build"; }

    local apk install_result
    apk="$(native_path "${app}/android/app/build/outputs/apk/release/app-release.apk")"
    install_result="$(adb install -r "${apk}" 2>&1)" || fail_step "adb install: ${install_result}"

    local hierarchy="${work}/hierarchy.xml"
    local control_log="${logs}/1-heap-free.log"
    local new_thread_log="${logs}/2-heap-full-new-thread.log"
    local attached_thread_log="${logs}/3-heap-full-attached-thread.log"
    run_launch "${control_label}" "${control_log}" "${hierarchy}"
    run_launch "${new_thread_label}" "${new_thread_log}" "${hierarchy}"
    run_launch "${attached_thread_label}" "${attached_thread_log}" "${hierarchy}"
    echo "logs: logs/${control_log##*/}, logs/${new_thread_log##*/}, logs/${attached_thread_log##*/}"

    local verdict_script control_file new_thread_file attached_thread_file
    verdict_script="$(native_path "${here}/print-verdict.mjs")"
    control_file="$(native_path "${control_log}")"
    new_thread_file="$(native_path "${new_thread_log}")"
    attached_thread_file="$(native_path "${attached_thread_log}")"
    node "${verdict_script}" "${control_label}=${control_file}" "${new_thread_label}=${new_thread_file}" \
        "${attached_thread_label}=${attached_thread_file}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
