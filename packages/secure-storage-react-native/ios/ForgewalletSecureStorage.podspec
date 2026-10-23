require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ForgewalletSecureStorage'
  s.version        = package['version']
  s.summary        = 'Device secret storage for forgewallet wallets'
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'forgewallet'
  s.homepage       = 'https://docs.anywallet.tech'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ultratestbro/forgewallet.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
  s.frameworks = 'Security', 'LocalAuthentication'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
