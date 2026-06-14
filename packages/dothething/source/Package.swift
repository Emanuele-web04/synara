// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "DoTheThing",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "DoTheThingKit",
            targets: ["DoTheThingKit"]
        ),
        .executable(
            name: "DoTheThing",
            targets: ["DoTheThing"]
        ),
        .executable(
            name: "DoTheThingFixture",
            targets: ["DoTheThingFixture"]
        ),
        .executable(
            name: "DoTheThingSmokeSuite",
            targets: ["DoTheThingSmokeSuite"]
        ),
        .executable(
            name: "CursorMotion",
            targets: ["CursorMotion"]
        ),
        .executable(
            name: "StandaloneCursor",
            targets: ["StandaloneCursor"]
        ),
    ],
    targets: [
        .target(
            name: "DoTheThingKit",
            path: "packages/DoTheThingKit/Sources/DoTheThingKit"
        ),
        .executableTarget(
            name: "DoTheThing",
            dependencies: ["DoTheThingKit"],
            path: "apps/DoTheThing/Sources/DoTheThing"
        ),
        .executableTarget(
            name: "DoTheThingFixture",
            dependencies: ["DoTheThingKit"],
            path: "apps/DoTheThingFixture/Sources/DoTheThingFixture"
        ),
        .executableTarget(
            name: "DoTheThingSmokeSuite",
            dependencies: ["DoTheThingKit"],
            path: "apps/DoTheThingSmokeSuite/Sources/DoTheThingSmokeSuite"
        ),
        .executableTarget(
            name: "CursorMotion",
            path: "experiments/CursorMotion/Sources/CursorMotion"
        ),
        .target(
            name: "StandaloneCursorSupport",
            path: "experiments/StandaloneCursor/Sources/StandaloneCursorSupport"
        ),
        .executableTarget(
            name: "StandaloneCursor",
            dependencies: ["StandaloneCursorSupport"],
            path: "experiments/StandaloneCursor/Sources/StandaloneCursor"
        ),
        .testTarget(
            name: "DoTheThingKitTests",
            dependencies: ["DoTheThingKit"],
            path: "packages/DoTheThingKit/Tests/DoTheThingKitTests"
        ),
        .testTarget(
            name: "StandaloneCursorSupportTests",
            dependencies: ["StandaloneCursorSupport"],
            path: "experiments/StandaloneCursor/Tests/StandaloneCursorSupportTests"
        ),
    ]
)
