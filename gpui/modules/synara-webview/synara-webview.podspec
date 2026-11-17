require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = "synara-webview"
  s.version      = package['version']
  s.summary      = "Synara embedded web view component"
  s.license      = "MIT"
  s.authors      = "Synara"
  s.homepage     = "https://github.com/Emanuele-web04/synara"
  s.platforms    = { :ios => min_ios_version_supported }

  s.source       = { :git => "https://github.com/Emanuele-web04/synara.git", :tag => "v#{s.version}" }
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.frameworks   = "WebKit"

  s.dependency "React-Core"
  install_modules_dependencies(s)
end
