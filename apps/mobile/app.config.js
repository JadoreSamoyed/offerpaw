const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

// Personal/cloud builds use HTTPS. Only explicit LAN development builds allow HTTP.
module.exports = ({ config }) => {
  const localNetwork = process.env.APP_ALLOW_LOCAL_HTTP === "1";
  let httpsIp;
  if (process.env.EXPO_PUBLIC_API_URL) {
    const endpoint = new URL(process.env.EXPO_PUBLIC_API_URL);
    if (endpoint.protocol === "https:" && /^(\d{1,3}\.){3}\d{1,3}$/.test(endpoint.hostname)) {
      httpsIp = endpoint.hostname;
    }
  }
  const withNetworkPolicy = (input) => {
    input = withAndroidManifest(input, (mod) => {
      const application = mod.modResults.manifest.application?.[0];
      if (application) application.$["android:usesCleartextTraffic"] = String(localNetwork);
      return mod;
    });
    return withInfoPlist(input, (mod) => {
      mod.modResults.NSAppTransportSecurity = {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: localNetwork,
        ...(httpsIp ? {
          NSExceptionDomains: { [httpsIp]: { NSExceptionAllowsInsecureHTTPLoads: false } },
        } : {}),
      };
      if (localNetwork) {
        mod.modResults.NSLocalNetworkUsageDescription = "连接同一 Wi-Fi 内电脑上的面试辅助服务。";
      } else {
        delete mod.modResults.NSLocalNetworkUsageDescription;
      }
      return mod;
    });
  };
  return {
    ...config,
    scheme: "tingda",
    icon: "./assets/icon.png",
    ios: {
      ...config.ios,
      buildNumber: "1",
      bundleIdentifier: process.env.APP_BUNDLE_IDENTIFIER || config.ios.bundleIdentifier,
    },
    android: {
      ...config.android,
      versionCode: 1,
      allowBackup: false,
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#236B51",
      },
      blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW"],
    },
    plugins: [...(config.plugins || []), withNetworkPolicy],
  };
};
