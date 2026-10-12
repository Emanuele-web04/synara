cask "synara" do
  arch arm: "arm64", intel: "x64"

  version "1.0.1"
  sha256 arm:   "d2e63ec2ff7da36de3531ca95ef8ac2b4161631fee9f94e3da15b31ff393d3ea",
         intel: "c6ce67a500e92c3f26fb885fbf1be2c901aa401f71ff13a8b0bb9a1104df3ddb"

  url "https://github.com/Emanuele-web04/synara/releases/download/v#{version}/Synara-#{version}-#{arch}.dmg",
      verified: "github.com/Emanuele-web04/synara/"
  name "Synara"
  desc "Desktop workspace for coding agents"
  homepage "https://www.trysynara.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  # Bundled Claude and Cua executables require macOS 13.
  depends_on macos: :ventura

  app "Synara.app"

  uninstall quit: "com.emanueledipietro.synara"

  zap trash: [
    "~/.synara",
    "~/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/com.emanueledipietro.synara.sfl*",
    "~/Library/Application Support/synara",
    "~/Library/Caches/com.emanueledipietro.synara",
    "~/Library/Caches/com.emanueledipietro.synara.ShipIt",
    "~/Library/HTTPStorages/com.emanueledipietro.synara",
    "~/Library/Logs/Synara",
    "~/Library/Preferences/com.emanueledipietro.synara.plist",
    "~/Library/Saved Application State/com.emanueledipietro.synara.savedState",
  ]
end
