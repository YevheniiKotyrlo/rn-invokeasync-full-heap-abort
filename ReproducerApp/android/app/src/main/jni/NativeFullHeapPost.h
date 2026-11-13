#pragma once

#include <AppSpecsJSI.h>

#include <memory>

namespace facebook::react {

struct FullHeapScenario;

class NativeFullHeapPost : public NativeFullHeapPostCxxSpec<NativeFullHeapPost> {
 public:
  explicit NativeFullHeapPost(std::shared_ptr<CallInvoker> jsInvoker);

  void postFromOwnThread(
      jsi::Runtime& runtime,
      bool fillJavaHeap,
      bool attachThreadFirst,
      AsyncCallback<> onPosted);

  void release(jsi::Runtime& runtime);

 private:
  std::shared_ptr<FullHeapScenario> scenario_;
  bool started_ = false;
};

} // namespace facebook::react
