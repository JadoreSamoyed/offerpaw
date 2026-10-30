Pod::Spec.new do |s|
  s.name = 'InterviewAudio'
  s.version = '0.1.0'
  s.summary = 'Foreground PCM streaming and local interview recording'
  s.description = 'Captures mono 24 kHz PCM and stores a local WAV recording.'
  s.author = 'Interview Assistant'
  s.homepage = 'https://docs.expo.dev/modules/'
  s.license = { :type => 'MIT' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
