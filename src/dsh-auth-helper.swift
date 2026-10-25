// dsh-auth-helper — tiny macOS LocalAuthentication bridge for the DSH lock plugin.
//
//   --check            exit 0 when Touch ID is available and enrolled
//   --auth <reason>    show the system sheet (Touch ID, or the login password as
//                      the macOS fallback) and exit 0 on success
//
// Passwords never pass through this helper: LocalAuthentication performs the
// whole check inside the system UI and only reports success or failure.

import Foundation
import LocalAuthentication

let arguments = CommandLine.arguments
let mode = arguments.count > 1 ? arguments[1] : "--check"
let reason = arguments.count > 2 && !arguments[2].isEmpty ? arguments[2] : "解锁 DeepSeek Harness"

if mode == "--check" {
    let context = LAContext()
    var error: NSError?
    let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    print(available ? "available" : "unavailable")
    exit(available ? 0 : 1)
}

let context = LAContext()
var policyError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
    print("unavailable: \(policyError?.localizedDescription ?? "no device authentication")")
    exit(2)
}

let semaphore = DispatchSemaphore(value: 0)
var succeeded = false
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
    succeeded = ok
    if !ok {
        print("failed: \(error?.localizedDescription ?? "cancelled")")
    }
    semaphore.signal()
}

// The callback is delivered on a run loop; keep pumping it under a deadline so
// a dismissed or ignored prompt can never hang the host request forever.
let deadline = Date().addingTimeInterval(110)
while semaphore.wait(timeout: .now()) == .timedOut {
    if Date() > deadline {
        print("timeout")
        exit(3)
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}
exit(succeeded ? 0 : 1)
