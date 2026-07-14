import { describe, expect, it } from "vitest";

import { applyElementOperations } from "./scene";

const TCP_IP_PROMPT = "绘制 TCP/IP 协议栈架构图，看到正确的分层架构展示";

const layerOperations = [
  {
    id: "layer-application",
    type: "rectangle",
    x: 120,
    y: 100,
    width: 760,
    height: 120,
    backgroundColor: "#d0ebff",
    fillStyle: "solid",
    label: { text: "应用层 · HTTP / HTTPS · DNS · DHCP", fontSize: 22 },
  },
  {
    id: "layer-transport",
    type: "rectangle",
    x: 120,
    y: 250,
    width: 760,
    height: 120,
    backgroundColor: "#d3f9d8",
    fillStyle: "solid",
    label: { text: "传输层 · TCP · UDP", fontSize: 22 },
  },
  {
    id: "layer-internet",
    type: "rectangle",
    x: 120,
    y: 400,
    width: 760,
    height: 120,
    backgroundColor: "#fff3bf",
    fillStyle: "solid",
    label: { text: "网际层 · IPv4 / IPv6 · ICMP", fontSize: 22 },
  },
  {
    id: "layer-access",
    type: "rectangle",
    x: 120,
    y: 550,
    width: 760,
    height: 120,
    backgroundColor: "#ffe8cc",
    fillStyle: "solid",
    label: { text: "网络接入层 · Ethernet · Wi-Fi · ARP", fontSize: 22 },
  },
  {
    id: "encapsulation",
    type: "arrow",
    x: 920,
    y: 150,
    width: 0,
    height: 450,
    points: [
      [0, 0],
      [0, 450],
    ],
    endArrowhead: "arrow",
    label: { text: "封装：数据 → 段/数据报 → 包 → 帧", fontSize: 16 },
  },
] satisfies Array<Record<string, unknown>>;

describe(`TCP/IP benchmark: ${TCP_IP_PROMPT}`, () => {
  it("produces the correct editable four-layer ordering and protocol ownership", () => {
    const scene = applyElementOperations({ elements: [], appState: {}, files: {} }, layerOperations);
    const layers = scene.elements.filter((element) => String(element.id).startsWith("layer-"));
    expect(layers.map((element) => element.id)).toEqual([
      "layer-application",
      "layer-transport",
      "layer-internet",
      "layer-access",
    ]);
    expect(layers.map((element) => element.y)).toEqual([100, 250, 400, 550]);

    const labels = layers.map((element) => String((element.label as { text: string }).text));
    expect(labels[0]).toMatch(/HTTP.*DNS.*DHCP/);
    expect(labels[1]).toMatch(/TCP.*UDP/);
    expect(labels[2]).toMatch(/IPv4.*IPv6.*ICMP/);
    expect(labels[3]).toMatch(/Ethernet.*Wi-Fi.*ARP/);
    expect(scene.elements.at(-1)).toMatchObject({
      id: "encapsulation",
      type: "arrow",
      endArrowhead: "arrow",
    });
  });
});
