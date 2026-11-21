// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "ACHelper",
    platforms: [.macOS(.v26)],
    targets: [
        .target(name: "HelperCore"),
        .executableTarget(name: "ac-helper", dependencies: ["HelperCore"]),
        // The replay's own window for the control ops (Tests/replay.py).
        .executableTarget(name: "ac-helper-testwindow"),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"]),
    ],
    swiftLanguageModes: [.v5]
)
