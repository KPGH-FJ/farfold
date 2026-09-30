import Foundation
import Security
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrAccount as String: "farfold",
  kSecReturnAttributes as String: true,
  kSecReturnData as String: false,
  kSecMatchLimit as String: kSecMatchLimitAll
]
var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
var services: [String] = []
if status == errSecSuccess, let entries = result as? [[String: Any]] {
  services = entries.compactMap { $0[kSecAttrService as String] as? String }.sorted()
}
let report: [String: Any] = ["status": Int(status), "account": "farfold", "services": services, "secretValuesRead": false]
let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
if status != errSecSuccess && status != errSecItemNotFound { exit(1) }
