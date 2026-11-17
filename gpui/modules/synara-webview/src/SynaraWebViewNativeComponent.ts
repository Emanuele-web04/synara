import {
  codegenNativeComponent,
  type CodegenTypes,
  type HostComponent,
  type ViewProps,
} from "react-native";

export type SynaraWebViewLoadEvent = Readonly<{
  /** The address the view finished loading. */
  url: string;
}>;

/** A web view showing a URL. */
export interface NativeProps extends ViewProps {
  url?: string;
  /** Sent when the web view reports that navigation finished. */
  onLoad?: CodegenTypes.DirectEventHandler<SynaraWebViewLoadEvent>;
}

export type SynaraWebViewType = HostComponent<NativeProps>;

export default codegenNativeComponent<NativeProps>("SynaraWebView", {
  interfaceOnly: true,
});
