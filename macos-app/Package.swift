// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RemoteTool",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "RemoteTool", targets: ["RemoteTool"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "RemoteTool",
            dependencies: [],
            path: "Sources"
        )
    ]
)
