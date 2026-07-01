import { type SVGProps, useId } from "react";
import type { IconType } from "react-icons";
import {
  SiAndroidstudio,
  SiClion,
  SiDatagrip,
  SiGoland,
  SiIntellijidea,
  SiOpenai,
  SiPhpstorm,
  SiPycharm,
  SiRider,
  SiRubymine,
  SiSublimetext,
  SiWarp,
  SiWebstorm,
  SiWindsurf,
  SiXcode,
} from "react-icons/si";

export type Icon = React.FC<SVGProps<SVGSVGElement>>;

// Adapts Simple Icons components to the app's SVG icon shape without changing call sites.
function adaptSimpleIcon(Component: IconType): Icon {
  return function SimpleIcon({ color, ...props }) {
    const iconProps = props as Omit<SVGProps<SVGElement>, "color">;
    return <Component {...iconProps} {...(typeof color === "string" ? { color } : {})} />;
  };
}

export const GitHubIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1024 1024" fill="none">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"
      transform="scale(64)"
      fill="currentColor"
    />
  </svg>
);

export const CursorIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 466.73 532.09" fill="currentColor">
    <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
  </svg>
);

export const VisualStudioCode: Icon = (props) => {
  const id = useId();
  const maskId = `${id}-vscode-a`;
  const topShadowFilterId = `${id}-vscode-b`;
  const sideShadowFilterId = `${id}-vscode-c`;
  const overlayGradientId = `${id}-vscode-d`;

  return (
    <svg {...props} fill="none" viewBox="0 0 100 100">
      <mask id={maskId} width="100" height="100" x="0" y="0" maskUnits="userSpaceOnUse">
        <path
          fill="#fff"
          fillRule="evenodd"
          d="M70.912 99.317a6.223 6.223 0 0 0 4.96-.19l20.589-9.907A6.25 6.25 0 0 0 100 83.587V16.413a6.25 6.25 0 0 0-3.54-5.632L75.874.874a6.226 6.226 0 0 0-7.104 1.21L29.355 38.04 12.187 25.01a4.162 4.162 0 0 0-5.318.236l-5.506 5.009a4.168 4.168 0 0 0-.004 6.162L16.247 50 1.36 63.583a4.168 4.168 0 0 0 .004 6.162l5.506 5.01a4.162 4.162 0 0 0 5.318.236l17.168-13.032L68.77 97.917a6.217 6.217 0 0 0 2.143 1.4ZM75.015 27.3 45.11 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#0065A9"
          d="M96.461 10.796 75.857.876a6.23 6.23 0 0 0-7.107 1.207l-67.451 61.5a4.167 4.167 0 0 0 .004 6.162l5.51 5.009a4.167 4.167 0 0 0 5.32.236l81.228-61.62c2.725-2.067 6.639-.124 6.639 3.297v-.24a6.25 6.25 0 0 0-3.539-5.63Z"
        />
        <g filter={`url(#${topShadowFilterId})`}>
          <path
            fill="#007ACC"
            d="m96.461 89.204-20.604 9.92a6.229 6.229 0 0 1-7.107-1.207l-67.451-61.5a4.167 4.167 0 0 1 .004-6.162l5.51-5.009a4.167 4.167 0 0 1 5.32-.236l81.228 61.62c2.725 2.067 6.639.124 6.639-3.297v.24a6.25 6.25 0 0 1-3.539 5.63Z"
          />
        </g>
        <g filter={`url(#${sideShadowFilterId})`}>
          <path
            fill="#1F9CF0"
            d="M75.858 99.126a6.232 6.232 0 0 1-7.108-1.21c2.306 2.307 6.25.674 6.25-2.588V4.672c0-3.262-3.944-4.895-6.25-2.589a6.232 6.232 0 0 1 7.108-1.21l20.6 9.908A6.25 6.25 0 0 1 100 16.413v67.174a6.25 6.25 0 0 1-3.541 5.633l-20.601 9.906Z"
          />
        </g>
        <path
          fill={`url(#${overlayGradientId})`}
          fillRule="evenodd"
          d="M70.851 99.317a6.224 6.224 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.633V16.413a6.25 6.25 0 0 0-3.54-5.632L75.812.874a6.226 6.226 0 0 0-7.104 1.21L29.294 38.04 12.126 25.01a4.162 4.162 0 0 0-5.317.236l-5.507 5.009a4.168 4.168 0 0 0-.004 6.162L16.186 50 1.298 63.583a4.168 4.168 0 0 0 .004 6.162l5.507 5.009a4.162 4.162 0 0 0 5.317.236L29.294 61.96l39.414 35.958a6.218 6.218 0 0 0 2.143 1.4ZM74.954 27.3 45.048 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
          opacity=".25"
          style={{ mixBlendMode: "overlay" }}
        />
      </g>
      <defs>
        <filter
          id={topShadowFilterId}
          width="116.727"
          height="92.246"
          x="-8.394"
          y="15.829"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter
          id={sideShadowFilterId}
          width="47.917"
          height="116.151"
          x="60.417"
          y="-8.076"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient
          id={overlayGradientId}
          x1="49.939"
          x2="49.939"
          y1=".258"
          y2="99.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export const Zed: Icon = (props) => {
  const id = useId();
  const clipPathId = `${id}-zed-logo-a`;

  return (
    <svg {...props} fill="none" viewBox="0 0 96 96">
      <g clipPath={`url(#${clipPathId})`}>
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M9 6a3 3 0 0 0-3 3v66H0V9a9 9 0 0 1 9-9h80.379c4.009 0 6.016 4.847 3.182 7.682L43.055 57.187H57V51h6v7.688a4.5 4.5 0 0 1-4.5 4.5H37.055L26.743 73.5H73.5V36h6v37.5a6 6 0 0 1-6 6H20.743L10.243 90H87a3 3 0 0 0 3-3V21h6v66a9 9 0 0 1-9 9H6.621c-4.009 0-6.016-4.847-3.182-7.682L52.757 39H39v6h-6v-7.5a4.5 4.5 0 0 1 4.5-4.5h21.257l10.5-10.5H22.5V60h-6V22.5a6 6 0 0 1 6-6h52.757L85.757 6H9Z"
          clipRule="evenodd"
        />
      </g>
      <defs>
        <clipPath id={clipPathId}>
          <path fill="#fff" d="M0 0h96v96H0z" />
        </clipPath>
      </defs>
    </svg>
  );
};

export const OpenAI: Icon = ({ color, ...props }) => {
  const iconProps = props as Omit<SVGProps<SVGElement>, "color">;

  return <SiOpenai {...iconProps} {...(typeof color === "string" ? { color } : {})} />;
};

export const ClaudeAI: Icon = ({ color, ...props }) => (
  <svg
    {...props}
    viewBox="0 0 256 257"
    fill="none"
    preserveAspectRatio="xMidYMid"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fill={typeof color === "string" ? color : "#D97757"}
      d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
    />
  </svg>
);

export const GhosttyIcon: Icon = (props) => (
  <svg {...props} fill="none" viewBox="0 0 27 32" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="#3551F3"
      d="M20.395 32a6.35 6.35 0 0 1-3.516-1.067A6.355 6.355 0 0 1 13.362 32c-1.249 0-2.48-.375-3.516-1.067A6.265 6.265 0 0 1 6.372 32h-.038a6.255 6.255 0 0 1-4.5-1.906 6.377 6.377 0 0 1-1.836-4.482v-12.25C0 5.995 5.994 0 13.362 0c7.369 0 13.363 5.994 13.363 13.363v12.253c0 3.393-2.626 6.192-5.978 6.375-.117.007-.234.009-.352.009Z"
    />
    <path
      fill="#000"
      d="M20.395 30.593a4.932 4.932 0 0 1-3.08-1.083.656.656 0 0 0-.42-.145.784.784 0 0 0-.487.176 4.939 4.939 0 0 1-3.046 1.055 4.939 4.939 0 0 1-3.045-1.055.751.751 0 0 0-.942 0 4.883 4.883 0 0 1-3.01 1.055h-.033a4.852 4.852 0 0 1-3.49-1.482 4.982 4.982 0 0 1-1.436-3.498V13.367c0-6.597 5.364-11.96 11.957-11.96 6.592 0 11.956 5.363 11.956 11.956v12.253c0 2.645-2.042 4.827-4.65 4.97a5.342 5.342 0 0 1-.274.007Z"
    />
    <path
      fill="#fff"
      d="M23.912 13.363v12.253c0 1.876-1.447 3.463-3.32 3.566a3.503 3.503 0 0 1-2.398-.769c-.778-.626-1.873-.598-2.658.021a3.5 3.5 0 0 1-2.176.753 3.494 3.494 0 0 1-2.173-.753 2.153 2.153 0 0 0-2.684 0 3.498 3.498 0 0 1-2.15.753c-1.948.014-3.54-1.627-3.54-3.575v-12.25c0-5.825 4.724-10.549 10.55-10.549 5.825 0 10.549 4.724 10.549 10.55Z"
    />
    <path
      fill="#000"
      d="m11.28 12.437-3.93-2.27a1.072 1.072 0 0 0-1.463.392 1.072 1.072 0 0 0 .391 1.463l2.326 1.343-2.326 1.343a1.072 1.072 0 0 0 1.071 1.855l3.932-2.27a1.071 1.071 0 0 0 0-1.854v-.002ZM20.182 12.291h-5.164a1.071 1.071 0 1 0 0 2.143h5.164a1.071 1.071 0 1 0 0-2.143Z"
    />
  </svg>
);

export const TerminalAppIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 64 64" fill="none">
    <rect width="54" height="44" x="5" y="10" fill="#111827" rx="10" />
    <rect width="54" height="44" x="5" y="10" stroke="#6B7280" strokeWidth="3" rx="10" />
    <path
      stroke="#A7F3D0"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="5"
      d="m19 27 8 7-8 7"
    />
    <path stroke="#E5E7EB" strokeLinecap="round" strokeWidth="5" d="M34 41h11" />
  </svg>
);

export const WarpIcon = adaptSimpleIcon(SiWarp);
export const AndroidStudioIcon = adaptSimpleIcon(SiAndroidstudio);
export const CLionIcon = adaptSimpleIcon(SiClion);
export const DataGripIcon = adaptSimpleIcon(SiDatagrip);
export const GoLandIcon = adaptSimpleIcon(SiGoland);
export const IntelliJIdeaIcon = adaptSimpleIcon(SiIntellijidea);
export const JetBrainsIcon: Icon = (props) => (
  <svg
    {...props}
    preserveAspectRatio="xMidYMid"
    viewBox="0 0 256 256"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M0 0h256v256H0z" />
    <path
      d="M28 208h96v16H28v-16ZM24 66l7-7c1 2 4 4 6 4 3 0 5-2 5-6V32h11v25c0 5-1 9-4 12-3 2-6 4-10 4h-1c-5 0-10-2-14-6v-1Zm34-34h32v9H69v7h19v8H69v6h21v10H58V32Zm48 10H94V32h35v10h-12v30h-11V42ZM28 88h19c4-1 8 1 11 3 2 2 3 4 3 7 0 4-3 7-7 9 5 1 8 5 8 10 0 7-5 11-15 11H28V88Zm22 12c0-2-2-3-5-3h-6v7h5c4 0 6-1 6-4Zm-4 11h-7v8h7c3 0 5-1 5-4 0-2-1-3-4-3l-1-1Zm43 17-8-12h-4v12H66V88h18c4-1 9 1 13 4 2 2 3 5 3 9 0 6-3 11-8 13l8 11 16-37h10l17 40h-12l-2-7h-16l-3 7H89Zm32-27-5 11h9l-4-11Zm-38-4h-6v10h6c4 0 6-2 6-5s-2-5-6-5Zm62-9h11v40h-11V88Zm15 0h11l14 21V88h11v40h-10l-15-22v22h-11V88Zm38 34 6-8c4 3 8 5 13 5 3 0 4-1 4-3 0-1 0-2-3-3h-3l-1-1h-2l-2-1c-6-1-10-4-10-11s5-13 15-13c6 0 12 2 16 6l-5 7c-3-2-7-4-11-4-3 0-4 1-4 3l3 3h2l2 1c9 2 15 5 15 12 0 8-6 13-15 13h-1c-7 0-13-2-18-5l-1-1Z"
      fill="#FFF"
    />
  </svg>
);
export const PhpStormIcon = adaptSimpleIcon(SiPhpstorm);
export const PyCharmIcon = adaptSimpleIcon(SiPycharm);
export const RiderIcon = adaptSimpleIcon(SiRider);
export const RubyMineIcon = adaptSimpleIcon(SiRubymine);
export const SublimeTextIcon = adaptSimpleIcon(SiSublimetext);
export const WebStormIcon = adaptSimpleIcon(SiWebstorm);
export const WindsurfIcon = adaptSimpleIcon(SiWindsurf);
export const XcodeIcon = adaptSimpleIcon(SiXcode);

export const Gemini: Icon = (props) => (
  <svg {...props} viewBox="0 0 296 298" fill="none">
    <mask
      id="gemini__a"
      width="296"
      height="298"
      x="0"
      y="0"
      maskUnits="userSpaceOnUse"
      style={{ maskType: "alpha" }}
    >
      <path
        fill="#3186FF"
        d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"
      />
    </mask>
    <g mask="url(#gemini__a)">
      <g filter="url(#gemini__b)">
        <ellipse cx="163" cy="149" fill="#3689FF" rx="196" ry="159" />
      </g>
      <g filter="url(#gemini__c)">
        <ellipse cx="33.5" cy="142.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__d)">
        <ellipse cx="19.5" cy="148.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__e)">
        <path fill="#FA4340" d="M194 10.5C172 82.5 65.5 134.333 22.5 135L144-66l50 76.5Z" />
      </g>
      <g filter="url(#gemini__f)">
        <path fill="#FA4340" d="M190.5-12.5C168.5 59.5 62 111.333 19 112L140.5-89l50 76.5Z" />
      </g>
      <g filter="url(#gemini__g)">
        <path fill="#14BB69" d="M194.5 279.5C172.5 207.5 66 155.667 23 155l121.5 201 50-76.5Z" />
      </g>
      <g filter="url(#gemini__h)">
        <path fill="#14BB69" d="M196.5 320.5C174.5 248.5 68 196.667 25 196l121.5 201 50-76.5Z" />
      </g>
    </g>
    <defs>
      <filter
        id="gemini__b"
        width="464"
        height="390"
        x="-69"
        y="-46"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="18" />
      </filter>
      <filter
        id="gemini__c"
        width="265"
        height="273"
        x="-99"
        y="6"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__d"
        width="265"
        height="273"
        x="-113"
        y="12"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__e"
        width="299.5"
        height="329"
        x="-41.5"
        y="-130"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__f"
        width="299.5"
        height="329"
        x="-45"
        y="-153"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__g"
        width="299.5"
        height="329"
        x="-41"
        y="91"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__h"
        width="299.5"
        height="329"
        x="-39"
        y="132"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
    </defs>
  </svg>
);

const ANTIGRAVITY_ICON_DATA_URL =
  "data:image/png;base64,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";

export const AntigravityIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 128 128" fill="none">
    <image href={ANTIGRAVITY_ICON_DATA_URL} width="128" height="128" />
  </svg>
);

export const GrokIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="currentColor"
      d="M395.479 633.828 735.91 381.105c16.689-12.39 40.544-7.557 48.496 11.687 41.854 101.493 23.155 223.461-60.118 307.204-83.272 83.743-199.137 102.108-305.041 60.281l-115.691 53.866C469.49 928.202 670.987 899.995 796.901 773.282c99.875-100.439 130.807-237.345 101.884-360.806l.262.263C857.105 231.37 909.358 158.874 1016.4 10.6326 1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651v-.439L395.392 633.916"
    />
    <path
      fill="currentColor"
      d="M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668c75.146-75.571 198.264-106.414 305.741-61.072l115.428-53.602c-20.797-15.114-47.447-31.371-78.03-42.794-138.234-57.206-303.731-28.735-416.101 84.182C147.234 337.081 113.244 504.215 171.613 646.833c43.603 106.59-27.874 181.985-99.8745 258.083C46.2237 931.893 20.6216 958.87 0 987.429l325.139-292.09"
    />
  </svg>
);

export const DevinIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="currentColor"
      d="M5.49926 12.5676C5.65997 12.4747 5.85721 12.4747 6.01792 12.5676L8.25724 13.8604C8.26142 13.8625 8.26371 13.8656 8.26664 13.8677C8.30175 13.8895 8.33387 13.9133 8.36146 13.9409C8.36564 13.9451 8.36994 13.9502 8.37413 13.9544C8.39876 13.9811 8.42196 14.0097 8.44034 14.0406C8.44327 14.0461 8.44681 14.0503 8.44974 14.0553C8.46899 14.0896 8.4834 14.126 8.4947 14.164C8.49677 14.1723 8.49875 14.1803 8.50083 14.1886C8.51087 14.2279 8.51718 14.2681 8.51718 14.3104V15.6035C8.51718 16.1036 8.78661 16.5688 9.21852 16.8182C9.6504 17.0675 10.1877 17.0676 10.6196 16.8182L11.739 16.1716C11.775 16.1511 11.8133 16.1363 11.8527 16.125C11.861 16.1221 11.8681 16.1202 11.8764 16.1181C11.9145 16.1089 11.9535 16.1026 11.9928 16.1026H12.0104C12.0468 16.1038 12.0828 16.1089 12.1187 16.1173C12.1246 16.1193 12.1309 16.1193 12.1371 16.1214C12.1756 16.1314 12.2124 16.1467 12.2475 16.1663C12.2508 16.1684 12.2581 16.1708 12.2581 16.1708L14.4974 17.4636L14.4991 17.4644C14.6602 17.5573 14.759 17.7286 14.759 17.914V20.4999C14.759 20.6852 14.6598 20.8565 14.4991 20.9494L12.2597 22.2422C12.1794 22.2874 12.0898 22.3113 11.9998 22.3113C11.9098 22.3113 11.8202 22.2886 11.7399 22.2422L9.50053 20.9494C9.49635 20.9474 9.49406 20.9442 9.49113 20.9421C9.45604 20.9204 9.42431 20.8969 9.39631 20.8689C9.39213 20.8647 9.38783 20.8596 9.38364 20.8554C9.35898 20.8287 9.33583 20.7997 9.31743 20.7688C9.31452 20.7634 9.31134 20.7591 9.30844 20.7541C9.28922 20.7198 9.27436 20.6838 9.26307 20.6458C9.261 20.6375 9.25902 20.6296 9.25694 20.6213C9.2469 20.5819 9.2406 20.5417 9.24059 20.4995V19.2067C9.24059 18.7074 8.97152 18.2423 8.53966 17.9928C8.10691 17.7434 7.56928 17.7434 7.13737 17.9928L6.01792 18.6394C5.98197 18.6599 5.94399 18.6747 5.9047 18.686C5.89633 18.6889 5.88814 18.6909 5.87977 18.693C5.84176 18.7021 5.80378 18.7085 5.76451 18.7085H5.75798C5.75298 18.7085 5.74866 18.7064 5.74449 18.7064C5.70855 18.7052 5.67251 18.7001 5.63741 18.6917C5.63158 18.6905 5.62525 18.6897 5.61901 18.6876C5.58095 18.6776 5.54502 18.6619 5.50989 18.6423C5.50653 18.641 5.49926 18.6382 5.49926 18.6382L3.25994 17.3454C3.09881 17.2525 3 17.0813 3 16.8959V14.31C3 14.1245 3.09923 13.9533 3.25994 13.8604L5.49926 12.5676Z"
    />
    <path
      fill="currentColor"
      d="M17.9813 5.36002C18.142 5.26711 18.3392 5.26711 18.4999 5.36002L20.738 6.65318C20.8987 6.74609 20.998 6.91735 20.998 7.10276V9.68867C20.998 9.87407 20.8987 10.0453 20.738 10.1382L18.4987 11.431C18.4945 11.4331 18.4902 11.433 18.4873 11.4351C18.4509 11.4543 18.415 11.47 18.3769 11.4805C18.3711 11.4825 18.3648 11.4833 18.3585 11.4845C18.3238 11.4937 18.2874 11.4988 18.2514 11.4988C18.2477 11.4997 18.2433 11.5009 18.2392 11.5009H18.2343C18.1953 11.4996 18.1559 11.4946 18.1178 11.4854C18.1095 11.4833 18.1016 11.4805 18.0933 11.4784C18.0539 11.4671 18.0156 11.4523 17.9796 11.4318L16.8602 10.7852C16.4274 10.5358 15.8898 10.5358 15.4579 10.7852H15.4624C15.0305 11.0351 14.7615 11.4986 14.7614 11.9987C14.7614 12.4988 15.0305 12.9639 15.4624 13.2134C15.8943 13.4628 16.4316 13.4628 16.8634 13.2134L17.9829 12.5668C18.0189 12.5463 18.0572 12.5315 18.0965 12.5202C18.1048 12.5173 18.1119 12.5153 18.1202 12.5133C18.1583 12.5041 18.1974 12.4977 18.2367 12.4977H18.2531C18.2903 12.499 18.3262 12.5041 18.3622 12.5124C18.3685 12.5145 18.3735 12.5144 18.3798 12.5165C18.4178 12.5266 18.455 12.5422 18.4901 12.5619C18.4935 12.564 18.5007 12.566 18.5007 12.566L20.7401 13.8587C20.9012 13.9516 21 14.1229 21 14.3083V16.8942C21 17.0796 20.9008 17.2509 20.7401 17.3438L18.5007 18.6366C18.4204 18.6818 18.3304 18.7056 18.2408 18.7056C18.1512 18.7056 18.0612 18.683 17.9809 18.6366L15.7415 17.3438C15.7374 17.3417 15.7351 17.339 15.7321 17.3369C15.697 17.3151 15.6654 17.2909 15.6373 17.2633C15.6336 17.2591 15.6292 17.2544 15.6251 17.2502C15.6004 17.2234 15.5773 17.1945 15.5588 17.1636C15.5559 17.1586 15.5528 17.1542 15.5499 17.1493C15.5302 17.115 15.5158 17.079 15.5045 17.041C15.5024 17.0326 15.5004 17.0244 15.4984 17.016C15.4883 16.9767 15.482 16.9365 15.482 16.8942V15.6015C15.482 15.1022 15.213 14.637 14.7811 14.3876C14.3483 14.1382 13.8107 14.1382 13.3788 14.3876L12.2593 15.0346C12.2234 15.055 12.1854 15.0695 12.1461 15.0808C12.1377 15.0837 12.1296 15.086 12.1212 15.0881C12.0823 15.0973 12.044 15.1033 12.0047 15.1033H11.9998C11.9956 15.1032 11.9913 15.1012 11.9871 15.1012C11.9512 15.0999 11.9151 15.0953 11.88 15.0869C11.8742 15.0848 11.8679 15.0845 11.8617 15.0824C11.8236 15.0724 11.7864 15.0571 11.7513 15.0375C11.748 15.0354 11.7407 15.033 11.7407 15.033L9.50135 13.7402C9.34029 13.6473 9.24148 13.4764 9.24141 13.291V10.7047C9.24145 10.5194 9.34067 10.348 9.50135 10.2551L11.7407 8.96239C11.744 8.9603 11.7484 8.96039 11.7513 8.9583C11.7864 8.93909 11.8236 8.9238 11.8617 8.91334C11.8679 8.91126 11.873 8.91009 11.8792 8.90885C11.9143 8.89924 11.9504 8.89415 11.9875 8.89413H12.0051C12.044 8.89497 12.0835 8.90047 12.1216 8.90966C12.13 8.91176 12.1382 8.91493 12.1465 8.91702C12.1858 8.9283 12.2238 8.94276 12.2597 8.96321L13.3792 9.60979C13.8119 9.85922 14.3496 9.85922 14.7815 9.60979C15.2133 9.35908 15.4824 8.89429 15.4824 8.39551V7.10276C15.4824 7.06052 15.4896 7.02027 15.4988 6.98096C15.5009 6.97259 15.5028 6.9644 15.5049 6.95603C15.5162 6.91797 15.5306 6.8816 15.5503 6.84772C15.5524 6.84231 15.5563 6.83801 15.5593 6.83301C15.5781 6.80204 15.6008 6.77314 15.6255 6.74636C15.6292 6.74218 15.6336 6.73705 15.6377 6.73287C15.6666 6.7049 15.6987 6.68019 15.7325 6.65972C15.7355 6.65762 15.7419 6.65277 15.7419 6.65277L17.9813 5.36002Z"
    />
    <path
      fill="currentColor"
      d="M11.739 1.75846C11.8997 1.66556 12.097 1.66555 12.2577 1.75846L14.4991 3.0504C14.6602 3.1433 14.759 3.31459 14.759 3.49998V6.08548C14.759 6.27088 14.6598 6.44215 14.4991 6.53506L12.2597 7.82781C12.2564 7.8299 12.252 7.83021 12.2491 7.8323C12.214 7.85151 12.1768 7.86682 12.1388 7.87726C12.1329 7.87935 12.1266 7.8801 12.1204 7.88135C12.0856 7.89097 12.0493 7.89606 12.0133 7.89606C12.0095 7.89606 12.0052 7.89811 12.001 7.89811H11.9961C11.9572 7.89727 11.9177 7.89178 11.8796 7.88258C11.8717 7.88049 11.8634 7.87771 11.8551 7.87563C11.8158 7.86433 11.7775 7.84954 11.7415 7.82903L10.622 7.18246C10.1893 6.93309 9.65202 6.9327 9.22016 7.18246C8.78825 7.43231 8.51881 7.89745 8.51881 8.39632V9.68907C8.51881 9.73133 8.51207 9.77154 8.50287 9.81087C8.50079 9.81919 8.49841 9.82708 8.49633 9.83539C8.48503 9.8739 8.47105 9.91021 8.45138 9.94411C8.44929 9.94947 8.44489 9.95347 8.44197 9.95842C8.42315 9.98937 8.40044 10.0183 8.37576 10.0451C8.37162 10.0492 8.36764 10.0544 8.3635 10.0585C8.33464 10.0866 8.30216 10.1112 8.26827 10.1317C8.26553 10.1337 8.25999 10.1385 8.25928 10.1391L6.01955 11.4318C5.93921 11.477 5.84915 11.5009 5.75961 11.5009C5.66966 11.5009 5.58 11.4783 5.49967 11.4318L3.26035 10.1391V10.1399C3.09922 10.047 3.00041 9.87612 3.00041 9.6903V7.1048C3.00041 6.9194 3.09964 6.74813 3.26035 6.65522L5.49844 5.36124C5.50178 5.35916 5.50614 5.35922 5.50907 5.35716C5.54421 5.3375 5.58137 5.32184 5.61901 5.31138C5.62526 5.3093 5.63035 5.30813 5.63659 5.30729C5.67169 5.2981 5.70771 5.293 5.7449 5.29299H5.76247C5.80181 5.29424 5.84087 5.29931 5.87936 5.30852C5.88773 5.31061 5.89592 5.31337 5.90429 5.31547C5.94316 5.32676 5.98115 5.34158 6.01751 5.36206L7.13655 6.00823C7.5693 6.25767 8.10693 6.25767 8.53884 6.00823C8.97068 5.75752 9.23978 5.29238 9.23978 4.79354V3.50079C9.23978 3.45855 9.24692 3.41832 9.25612 3.379C9.2582 3.3707 9.26018 3.36278 9.26226 3.35448C9.27355 3.31642 9.28798 3.28004 9.30762 3.24617C9.3097 3.24119 9.31369 3.23683 9.31661 3.23186C9.33543 3.20091 9.35815 3.17199 9.38282 3.14522C9.38701 3.14103 9.39131 3.13591 9.39549 3.13173C9.42433 3.10374 9.45647 3.07905 9.49032 3.05857C9.49325 3.05648 9.49972 3.05121 9.49972 3.05121L11.739 1.75846Z"
    />
  </svg>
);

export const PiIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 800 800" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29V165.29ZM282.65 282.65V400H400V282.65H282.65Z"
      clipRule="evenodd"
    />
    <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36V400Z" />
  </svg>
);

export const OpenCodeIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#opencode__clip0_1311_94969)">
      <path d="M24 32H8V16H24V32Z" fill="#BCBBBB" />
      <path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="#211E1E" />
    </g>
    <defs>
      <clipPath id="opencode__clip0_1311_94969">
        <rect width="32" height="40" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

export const KiloIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="currentColor"
      d="M0 0v100h100V0H0Zm92.5925926 92.5925926H7.4074074V7.4074074h85.1851852v85.1851852ZM61.1111044 71.9096084h9.2592593v7.4074074H58.7301521l-5.026455-5.026455V62.6503482h7.4074074v9.2592602ZM77.7777711 71.9096084h-7.4074074v-9.2592602h-9.2592593v-7.4074074H72.751316l5.026455 5.026455v11.6402126ZM46.2962963 61.1114207h-7.4074074v-7.4074074h7.4074074v7.4074074ZM22.2222222 53.7040133h7.4074074V70.37068h16.6666667v7.4074074h-19.047619l-5.026455-5.026455V53.7040133ZM77.7777711 38.8888889v7.4074074H53.703697v-7.4074074h8.2781918v-9.2592593H53.703697v-7.4074074h10.6591442l5.026455 5.026455v11.6402116h8.3884749ZM29.6296296 30.5555556h9.2592593l7.4074074 7.4074074v8.3333333h-7.4074074V37.962963h-9.2592593v8.3333333h-7.4074074V22.2222222h7.4074074v8.3333334ZM46.2962963 30.5555556h-7.4074074v-8.3333334h7.4074074v8.3333334Z"
    />
  </svg>
);
