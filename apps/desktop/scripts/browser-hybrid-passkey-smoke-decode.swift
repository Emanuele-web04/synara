// Decode the dialog canvas in memory. Return only a digest for comparison with the native event.
import CryptoKit
import Foundation
import Vision

let png = FileHandle.standardInput.readDataToEndOfFile()
let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
try VNImageRequestHandler(data: png).perform([request])
guard let result = request.results, result.count == 1,
      let text = result[0].payloadStringValue else { exit(1) }
print(SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined())
