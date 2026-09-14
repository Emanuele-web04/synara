cask "synara" do
  arch arm: "arm64", intel: "x64"

  version "0.8.4"
  sha256 arm:   "6a957d8cdc7967555303f188dcf67816264cac72e2d377e11071e2d41db2733a",
         intel: "0b28212fa6ac9c3d7bd09a70c38ff36492ac4834ad8641a6361d148e9977c03a"

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
