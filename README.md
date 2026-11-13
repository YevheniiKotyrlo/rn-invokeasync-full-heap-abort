# Android: a post through `CallInvoker::invokeAsync` to an idle JS thread ends the process when Java's heap is full

![Build](https://github.com/YevheniiKotyrlo/rn-invokeasync-full-heap-abort/workflows/Pre%20Merge%20Checks/badge.svg)

React Native 0.90.0-nightly-20261113-6d587e873, from the [React Native reproducer template](https://github.com/react-native-community/reproducer-react-native). The app's C++ Turbo Module, `NativeFullHeapPost` (`ReproducerApp/android/app/src/main/jni/`), starts a `std::thread` that calls a JS callback through `AsyncCallback`, which posts it with the module's `CallInvoker::invokeAsync`. Each button runs one scenario, once per launch:

- **Post with the Java heap free**: the control.
- **Post from a new thread with the Java heap full**: the posting thread was never attached to the JVM.
- **Post from an attached thread with the Java heap full**: the posting thread attached itself before the heap filled.

One second after the tap, a second native thread holds the main thread in native code, so that the main thread neither allocates nor meets the full heap first, and fills Java's heap with byte arrays until a 16-byte one fails. Half a second later, with the JS thread idle, the posting thread calls the callback. The callback frees the heap and lets the main thread go; when it has not run 5 s after `invokeAsync` returns, the posting thread does. A second tap in the same launch does nothing.

## Steps

By hand, on an Android device:

1. Build and install the release APK: `cd ReproducerApp && yarn install && cd android && ./gradlew assembleRelease && adb install -r app/build/outputs/apk/release/app-release.apk`.
2. Open the app and tap **Post with the Java heap free**: the screen shows that the posted callback ran.
3. Open it again and tap **Post from a new thread with the Java heap full**: the app closes. `adb logcat` shows `Exception creating thread peer: full-heap-post`, `Abort message: 'result == JNI_OK'` and the backtrace `ThreadScope::ThreadScope()` ← `JMessageQueueThread::runOnQueue` ← `RuntimeScheduler_Modern::scheduleTask` ← `BufferedRuntimeExecutor::execute` ← `CallInvokerImpl::invokeAsync`.
4. Open it again and tap **Post from an attached thread with the Java heap full**: the app closes. `adb logcat` shows `Abort message: 'terminating due to uncaught exception of type facebook::jni::JniException: …'`, `std::terminate()` called from `RuntimeScheduler_Modern::scheduleTask`.

Scripted: `./reproduce.sh`, with one Android device attached, builds and installs the release APK, runs each scenario in a launch of its own and reads the app's lines of each launch's logcat (`print-verdict.mjs`, `verdict.mjs`). It exits 1 while a launch with the heap full ends inside `invokeAsync`, 0 once every post with the heap full returns and its callback runs, and 2 otherwise: a step fails, the control's callback does not run, or no launch ends inside `invokeAsync` while one ends another way or never runs its callback. The launches' logs land in `logs/`. Nothing else in the app gives the JS thread work, so it is idle at each post; an exit 0 relies on that.
