#import "SynaraWebViewComponentView.h"

#import <WebKit/WebKit.h>

#import <react/renderer/components/SynaraWebViewSpec/ComponentDescriptors.h>
#import <react/renderer/components/SynaraWebViewSpec/EventEmitters.h>
#import <react/renderer/components/SynaraWebViewSpec/Props.h>
#import <react/renderer/components/SynaraWebViewSpec/RCTComponentViewHelpers.h>

#import <React/RCTFabricComponentsPlugins.h>

using namespace facebook::react;

namespace facebook::react {
// The JS spec is codegen `interfaceOnly` (the desktop Rust crate supplies its
// own shadow node), so iOS declares the shadow node and descriptor here.
extern const char SynaraWebViewComponentName[] = "SynaraWebView";

using SynaraWebViewShadowNode = ConcreteViewShadowNode<
    SynaraWebViewComponentName,
    SynaraWebViewProps,
    SynaraWebViewEventEmitter>;

using SynaraWebViewComponentDescriptor = ConcreteComponentDescriptor<SynaraWebViewShadowNode>;
} // namespace facebook::react

@interface SynaraWebViewComponentView () <WKNavigationDelegate>
@end

@implementation SynaraWebViewComponentView {
  WKWebView *_webView;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<SynaraWebViewComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const SynaraWebViewProps>();
    _props = defaultProps;

    _webView = [[WKWebView alloc] initWithFrame:self.bounds];
    _webView.navigationDelegate = self;
    _webView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _webView.allowsBackForwardNavigationGestures = YES;
    self.contentView = _webView;
  }
  return self;
}

- (void)updateProps:(const facebook::react::Props::Shared &)props
           oldProps:(const facebook::react::Props::Shared &)oldProps
{
  const auto &oldViewProps = static_cast<const SynaraWebViewProps &>(*_props);
  const auto &newViewProps = static_cast<const SynaraWebViewProps &>(*props);

  if (oldViewProps.url != newViewProps.url && !newViewProps.url.empty()) {
    NSString *urlString = [NSString stringWithUTF8String:newViewProps.url.c_str()];
    NSURL *url = [NSURL URLWithString:urlString];
    if (url != nil) {
      [_webView loadRequest:[NSURLRequest requestWithURL:url]];
    }
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation
{
  if (_eventEmitter == nullptr) {
    return;
  }
  auto emitter = std::static_pointer_cast<const SynaraWebViewEventEmitter>(_eventEmitter);
  SynaraWebViewEventEmitter::OnLoad event{};
  if (webView.URL != nil && webView.URL.absoluteString != nil) {
    event.url = std::string(webView.URL.absoluteString.UTF8String);
  }
  emitter->onLoad(event);
}

@end

Class<RCTComponentViewProtocol> SynaraWebViewCls(void)
{
  return SynaraWebViewComponentView.class;
}
