// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Wandy",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "WandyKit",
            targets: ["WandyKit"]
        ),
        .executable(
            name: "Wandy",
            targets: ["Wandy"]
        ),
        .executable(
            name: "WandyFixture",
            targets: ["WandyFixture"]
        ),
        .executable(
            name: "WandySmokeSuite",
            targets: ["WandySmokeSuite"]
        ),
    ],
    targets: [
        .target(
            name: "WandyKit",
            path: "packages/WandyKit/Sources/WandyKit"
        ),
        .executableTarget(
            name: "Wandy",
            dependencies: ["WandyKit"],
            path: "apps/Wandy/Sources/Wandy"
        ),
        .executableTarget(
            name: "WandyFixture",
            dependencies: ["WandyKit"],
            path: "apps/WandyFixture/Sources/WandyFixture"
        ),
        .executableTarget(
            name: "WandySmokeSuite",
            dependencies: ["WandyKit"],
            path: "apps/WandySmokeSuite/Sources/WandySmokeSuite"
        ),
        .testTarget(
            name: "WandyKitTests",
            dependencies: ["WandyKit"],
            path: "packages/WandyKit/Tests/WandyKitTests"
        ),
    ]
)
