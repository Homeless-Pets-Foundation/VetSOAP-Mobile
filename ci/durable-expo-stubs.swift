// CI-ONLY stub — NOT shipped, NOT part of the app build.
//
// The durable recorder's DurableRecorderEngine.swift references `DurableException`
// (a subclass of ExpoModulesCore's `GenericException<String>`) which is defined in
// CaptivetDurableRecorderModule.swift. That module file imports the full
// ExpoModulesCore SDK (Module / Record / decorators) and therefore cannot be
// `swiftc -typecheck`'d without a CocoaPods install. To still typecheck the
// AAC/engine logic (where the F1 compile error and F3 crash lived) on a plain
// macOS runner, we exclude the module file and provide this minimal stand-in for
// the one ExpoModulesCore symbol the engine touches.
//
// Keep this in sync with CaptivetDurableRecorderModule.swift's DurableException and
// ExpoModulesCore's GenericException init `init(_ param: T)`. If the engine starts
// using more ExpoModulesCore surface, this typecheck will fail — which is the
// intended signal to extend the stub (or accept that only a full build covers it).

open class GenericException<T>: Error {
  public let param: T
  public init(_ param: T) { self.param = param }
  open var reason: T { param }
}

internal final class DurableException: GenericException<String> {
  override var reason: String { param }
}
