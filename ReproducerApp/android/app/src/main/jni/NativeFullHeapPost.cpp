#include "NativeFullHeapPost.h"

#include <android/log.h>
#include <fbjni/NativeRunnable.h>
#include <fbjni/fbjni.h>
#include <pthread.h>

#include <chrono>
#include <condition_variable>
#include <cstdarg>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>
#include <vector>

namespace facebook::react {

struct FullHeapScenario {
  std::mutex mutex;
  std::condition_variable changed;
  bool mainThreadHeld = false;
  bool heapReady = false;
  bool released = false;
  bool heapFreed = false;
};

namespace {

using namespace std::chrono_literals;

constexpr auto kPostingThreadName = "full-heap-post";
constexpr auto kHeapThreadName = "full-heap-fill";

void logLine(const char* format, ...) {
  va_list arguments;
  va_start(arguments, format);
  __android_log_vprint(ANDROID_LOG_INFO, "FullHeapPost", format, arguments);
  va_end(arguments);
}

struct JLooper : jni::JavaClass<JLooper> {
  static constexpr auto kJavaDescriptor = "Landroid/os/Looper;";

  static jni::local_ref<javaobject> getMainLooper() {
    static const auto method =
        javaClassStatic()->getStaticMethod<javaobject()>("getMainLooper");
    return method(javaClassStatic());
  }
};

struct JHandler : jni::JavaClass<JHandler> {
  static constexpr auto kJavaDescriptor = "Landroid/os/Handler;";

  static jni::local_ref<javaobject> forLooper(
      jni::alias_ref<JLooper::javaobject> looper) {
    return newInstance(looper);
  }

  void post(jni::JRunnable::javaobject runnable) {
    static const auto method =
        javaClassStatic()->getMethod<jboolean(jni::JRunnable::javaobject)>(
            "post");
    method(self(), runnable);
  }
};

using MainThreadHold = jni::global_ref<jni::JNativeRunnable::jhybridobject>;

// Made on the JS thread: a thread the JVM attaches later finds no app class through its system class loader.
MainThreadHold makeMainThreadHold(
    const std::shared_ptr<FullHeapScenario>& scenario) {
  return jni::make_global(jni::JNativeRunnable::newObjectCxxArgs([scenario]() {
    std::unique_lock lock(scenario->mutex);
    scenario->mainThreadHeld = true;
    scenario->changed.notify_all();
    scenario->changed.wait(lock, [&] { return scenario->heapFreed; });
  }));
}

// The main thread waits in native code until the heap is freed, so that it neither allocates nor meets the full heap first.
void holdMainThread(
    const std::shared_ptr<FullHeapScenario>& scenario,
    MainThreadHold& hold) {
  JHandler::forLooper(JLooper::getMainLooper())->post(hold.get());
  hold.reset();
  std::unique_lock lock(scenario->mutex);
  scenario->changed.wait(lock, [&] { return scenario->mainThreadHeld; });
}

jlong runtimeFigure(JNIEnv* env, jobject javaRuntime, const char* name) {
  jclass runtimeClass = env->GetObjectClass(javaRuntime);
  jlong figure = env->CallLongMethod(
      javaRuntime, env->GetMethodID(runtimeClass, name, "()J"));
  env->DeleteLocalRef(runtimeClass);
  return figure;
}

void fillHeapWithByteArrays(std::vector<jobject>& arrays) {
  JNIEnv* env = jni::Environment::current();
  jclass runtimeClass = env->FindClass("java/lang/Runtime");
  jobject javaRuntime = env->CallStaticObjectMethod(
      runtimeClass,
      env->GetStaticMethodID(
          runtimeClass, "getRuntime", "()Ljava/lang/Runtime;"));
  jlong maxMemory = runtimeFigure(env, javaRuntime, "maxMemory");
  jlong left = maxMemory - runtimeFigure(env, javaRuntime, "totalMemory") +
      runtimeFigure(env, javaRuntime, "freeMemory");
  env->DeleteLocalRef(javaRuntime);
  env->DeleteLocalRef(runtimeClass);

  jlong filled = 0;
  auto keep = [&](jsize size) {
    jbyteArray array = env->NewByteArray(size);
    if (array == nullptr) {
      env->ExceptionClear();
      return false;
    }
    arrays.push_back(env->NewGlobalRef(array));
    env->DeleteLocalRef(array);
    filled += size;
    return true;
  };
  constexpr jlong kSlack = 2 << 20;
  if (left > kSlack) {
    keep(static_cast<jsize>(left - kSlack));
  }
  for (jsize size = 1 << 20; size >= 16;) {
    if (!keep(size)) {
      size /= 2;
    }
  }
  logLine(
      "Java heap filled: %lld of its %lld bytes held in byte arrays, a 16-byte array failed",
      static_cast<long long>(filled),
      static_cast<long long>(maxMemory));
}

void fillAndHoldUntilReleased(
    const std::shared_ptr<FullHeapScenario>& scenario,
    bool fillJavaHeap,
    MainThreadHold& hold) {
  pthread_setname_np(pthread_self(), kHeapThreadName);
  jni::ThreadScope attachment;
  holdMainThread(scenario, hold);
  logLine("main thread held in native code");
  std::vector<jobject> arrays;
  if (fillJavaHeap) {
    fillHeapWithByteArrays(arrays);
  }
  std::unique_lock lock(scenario->mutex);
  scenario->heapReady = true;
  scenario->changed.notify_all();
  scenario->changed.wait(lock, [&] { return scenario->released; });
  JNIEnv* env = jni::Environment::current();
  for (jobject array : arrays) {
    env->DeleteGlobalRef(array);
  }
  scenario->heapFreed = true;
  scenario->changed.notify_all();
}

void releaseHeapAndMainThread(FullHeapScenario& scenario) {
  std::unique_lock lock(scenario.mutex);
  scenario.released = true;
  scenario.changed.notify_all();
  scenario.changed.wait(lock, [&] { return scenario.heapFreed; });
}

void postFromPostingThread(
    const std::shared_ptr<FullHeapScenario>& scenario,
    bool fillJavaHeap,
    bool attachThreadFirst,
    MainThreadHold& hold,
    const AsyncCallback<>& onPosted) {
  pthread_setname_np(pthread_self(), kPostingThreadName);
  std::optional<jni::ThreadScope> attachment;
  if (attachThreadFirst) {
    attachment.emplace();
  }
  std::this_thread::sleep_for(1s);
  std::thread(
      [scenario, fillJavaHeap, hold = std::move(hold)]() mutable {
        fillAndHoldUntilReleased(scenario, fillJavaHeap, hold);
      })
      .detach();
  {
    std::unique_lock lock(scenario->mutex);
    scenario->changed.wait(lock, [&] { return scenario->heapReady; });
  }
  std::this_thread::sleep_for(500ms);
  logLine(
      "posting the callback from %s (%s) through CallInvoker::invokeAsync",
      kPostingThreadName,
      attachThreadFirst ? "attached to the JVM before the fill"
                        : "not attached to the JVM");
  onPosted();
  logLine("invokeAsync returned");
  bool callbackRan = false;
  {
    std::unique_lock lock(scenario->mutex);
    callbackRan = scenario->changed.wait_for(
        lock, 5s, [&] { return scenario->released; });
  }
  if (!callbackRan) {
    logLine("the posted callback did not run within 5 s");
    releaseHeapAndMainThread(*scenario);
    logLine("Java heap freed, main thread released");
  }
}

} // namespace

NativeFullHeapPost::NativeFullHeapPost(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeFullHeapPostCxxSpec(std::move(jsInvoker)),
      scenario_(std::make_shared<FullHeapScenario>()) {}

void NativeFullHeapPost::postFromOwnThread(
    jsi::Runtime& /*runtime*/,
    bool fillJavaHeap,
    bool attachThreadFirst,
    AsyncCallback<> onPosted) {
  if (started_) {
    logLine("ignored: the app runs one scenario per launch");
    return;
  }
  started_ = true;
  logLine(
      "scenario: Java heap %s, posting thread %s",
      fillJavaHeap ? "full" : "free",
      attachThreadFirst ? "attached first" : "never attached");
  std::thread([scenario = scenario_,
               fillJavaHeap,
               attachThreadFirst,
               hold = makeMainThreadHold(scenario_),
               onPosted = std::move(onPosted)]() mutable {
    postFromPostingThread(
        scenario, fillJavaHeap, attachThreadFirst, hold, onPosted);
  }).detach();
}

void NativeFullHeapPost::release(jsi::Runtime& /*runtime*/) {
  logLine("the posted callback ran on the JS thread");
  releaseHeapAndMainThread(*scenario_);
  logLine("Java heap freed, main thread released");
}

} // namespace facebook::react
