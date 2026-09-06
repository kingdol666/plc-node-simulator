# PLC 节点真实模拟器

多协议虚拟工业设备,作为**真实 PLC 的替身**:模拟物理设备中的信号源与数据通信发出,与 AgentWorkShop 全链路对接(数采采集 + 数控写控 + 实时监视 + 故障演练)。

## 一键启动

```bash
npm install
npm run dev          # 服务 http://127.0.0.1:4010 (UI 内置)
# 浏览器打开 http://127.0.0.1:4010 → 点「薄膜产线预设」→ 五协议设备即出数
```

Windows 注意:本机回环连接需 `NO_PROXY=127.0.0.1,localhost`(代理会劫持 fetch/net)。

## 支持的协议(与 AgentWorkShop 全部协议一一对应)

| 协议 | 角色 | 默认端口 | 说明 |
|---|---|---|---|
| Modbus TCP | 从站(ServerTCP) | 16040 | FC03/04/06/16;float32/int16/int32/uint16/uint32;big/little/wordSwap 字节序(与主项目 decodeRegisters 同约定) |
| Modbus RTU over TCP | 从站(手写帧) | 15041 | `mbap` 模式与主项目 `connectTcpRTUBuffered` 互通(事务 id 回显,客户端补 CRC);`raw-rtu` 模式带真 CRC16 供真实网关 |
| OPC UA | 服务器(node-opcua) | 5840 | 自定义命名空间(默认 ns=2,与主项目 nodeId 约定一致);可写 setpoint 节点回灌;可选用户名密码 |
| MQTT | 设备侧 publisher + **内置 mini-broker** | 18830 | 每 tick 发布信号值到任意 broker(默认内置 18830);payload 模板 `{"data":{"temp":${value}}}`(与主项目 jsonPath 兼容);commandTopic 接收 DCW 下行写并回灌 |
| HTTP | GET 端点 | 4010(同 UI) | `/sim-http/{deviceId}{path}` 返回纯数字文本或 JSON 模板 |

## 数据生成引擎(模拟真实物理设备)

每信号独立策略 + 故障注入 + 标定(`输出 = value × scale + offset`):

- **策略**:constant / sine(正弦) / random-walk(随机游走+钳位) / ramp(斜坡+循环) / **first-order(一阶惯性工艺闭环,PV→SP 收敛,抄主项目 dev-plc-simulator 已验证动力学)** / expression(表达式,`[信号名]` 引用其他信号) / manual(手动覆写)
- **故障注入**:stuckAt 卡值 / spike 尖峰越限(触发主项目 daq.alarm) / drift 漂移 / disconnect 断链(端口关闭/HTTP 503,窗后自愈)
- **SP→PV 联动**:SP 寄存器地址配 `writebackTarget` → 外部写 SP 同步更新目标回路的 first-order.sp(真实 PLC 控制语义)

## Web UI

- 设备卡片:协议徽章/端点/实时值/迷你趋势,启停
- 编辑器:通信配置 + 寄存器/变量/主题/端点映射表 + 信号策略参数 + 故障注入
- 点击信号数值 → 手动覆写(模拟操作工设定)
- 「薄膜产线预设」一键生成五协议模拟产线(信号语义对齐主项目 DAQ 模板)
- **对接导出**:每设备生成主项目 driverConfig JSON + curl(test-driver 两条),消除手工对照
- 配置导入/导出 JSON(data/config.json 原子写,重启不丢)

## 与 AgentWorkShop 对接

1. 主项目 `/daq` 页「添加节点 → 真实协议」→ 按模拟器「对接导出」的 driverConfig 填写(或用其 curl 调 `POST /api/workshop/daq/test-driver` 验证后创建)。
2. 产线开跑 → 采集落 TSDB → WS 实时推送 → DCW 写 SP → 模拟器寄存器更新 → DAQ 回读收敛(真实协议栈闭环)。
3. 全链路集成 e2e:

```bash
# 前置:模拟器运行中 + 已应用 film-line 预设;主项目运行中(env AW_BASE,默认 http://127.0.0.1:3001)
NO_PROXY='*' AW_BASE=http://127.0.0.1:3001 node scripts/e2e-integration.mjs
```

覆盖:五协议连接测试 ×5 → 采样落库 ×5 → DCW 写 SP=182 回读一致 + PV 一阶收敛 → DCW MQTT 下行回灌 → 断链演练(停设备拒/恢复重连)。

## 自测

```bash
npm test   # 引擎 19 + modbus 6 + opcua 4 + mqtt 3 + http 3 = 35 断言
```

## 端口汇总(全部可配,env)

UI/API `4010`(SIM_PORT)|modbus-tcp `16040`|modbus-rtu `15041`|opcua `5840`|内置 mqtt-broker `18830`(MQTT_BROKER_PORT)|http 端点同 UI

## 架构

```
src/server/
  index.ts            入口:h3(API+HTTP 端点+静态前端)+ WS + broker
  api.ts              REST(设备 CRUD/启停/手动覆写/策略覆写/导出/预设)
  store.ts            config.json 原子写
  runtime.ts          每设备 tick:信号推进 + WS 推送
  engine/signals.ts   策略数学 + 故障注入 + 写回灌(纯函数)
  engine/registers.ts 编码/解码(与主项目 decodeRegisters 对称)+ CRC16
  protocols/          modbus-tcp / modbus-rtu / opcua / mqtt / http-endpoint / mqtt-broker / registry
web/                  Vue3 + Vite(dark 控制室主题,绿 #3fe4ab / 青 #41c8f4 / 深海军蓝)
tests/                引擎 + 四协议自测(真实客户端库)
scripts/e2e-integration.mjs  跨项目全链路 e2e
```

## Windows 坑规避(沿用主项目经验)

- 回环连接一律 `NO_PROXY=127.0.0.1,localhost`
- 端口清场:`netstat -ano | findstr :PORT | findstr LISTENING` → `taskkill /F /PID`(只杀目标端口,勿全量杀 node)
- 日志落盘审计(确定性验收不依赖时序)
