---
theme: ./slidev-theme-gdut
title: 基于 KV Cache TTL 的多轮 Agent调度
layout: cover
subtitle: "Continuum: Efficient and Robust Multi-Turn LLM Agent Scheduling with KV Cache Time-to-Live"
reporter: 林浩扬
advisor: 张金泉
date: 2026/09/28
sections:
  - 研究背景与动机 
  - 研究内容
  - 实验演示与分析 
  - 反思与创新
transition: slide-left
mdc: true
---


---

# 论文信息与一句话概括

| 条目  | 内容                                                                               |
| --- | -------------------------------------------------------------------------------- |
| 作者  | Hanchen Li, Runyuan He, Qiuyang Mang 等（UC Berkeley / Stanford / 清华，Ion Stoica 组） |
| 发表  | ICLR workshop 2026；PVLDB Vol.20（2027）双盲审稿中                                       |
| 代码  | github.com/Hanchenli/vllm-continuum                                              |

> 切入点是**调度**，不是缓存本身。工具调用只是一个**短暂停顿**，现有引擎却把它当成请求结束，把 KV 驱逐掉，跨轮复用随之失效。

- 按"**重建代价 vs 驱逐引起的排队延迟**"算出一个 **TTL**：工具调用期间把 KV 钉在显存里，到期自动释放
- 配合 **program 级 FCFS**，优化整个 agent 任务的完成时间（JCT），而不是单个请求的延迟

> [!NOTE] 一句话概括，也是和 InferCept（ICML'24）的区别
> 即使重算很便宜，也应该保留 KV cache：**你保留的不是数据，是队列位置。**
> InferCept 只比较重建代价，offload 让重建变便宜后它就不再保留 KV。

---
layout: toc
active: 1
---

---
layout: two-cols
---

# ReAct Agent架构

![ReAct](./public/images/ReAct复杂图.png){width=520 height=260 object-contain}
*ReAct = Reasoning + Acting：先想、动手查、看结果再想，直到问题解决 ——ReAct架构（ICLR 2023）*

::right::

## ReAct 的工作流程

1. **接收任务**：用户给 LLM 一个任务或问题。
2. **Reason（思考）**：LLM 生成思维链，理解问题、拆解任务、决定下一步
3. **Act（行动）**：调用外部工具，如搜索引擎、代码解释器、各类 API
4. **Observe（观察）**：工具输出追加到上下文，触发下一轮推理
5. **循环**：LLM分析结果，是继续使用工具、还是得到最终答案并准备输出。
6. **输出答案**：当 LLM 认为任务已经完成时，它会生成最终的答案。

> 对推理引擎来说，一个 agent program 是一串**共享前缀、不断变长**的 LLM 请求，中间夹着长短不一的工具调用。

---
layout: top-bottom
---
# 实际场景参考：一条真实的 Agent trace

![实际场景图参考](./public/images/实际场景图.png){.h-60 .mx-auto}

*这是我截取自己的deepseek harness中的图片，紫 = 模型推理reference，橙 = 工具调用tool call。*

- **推理与工具交替**：每轮都带着 system prompt + 全部历史重新发请求，前缀共享、越来越长
- **开头几次 tool call 很短**：橙条细碎，模型几乎马上接着推理，这时删掉 KV 马上又要重建
- **后面有一次特别长**：一整条长橙条，这段时间还占着 KV 就是白白浪费显存
- **同一个工具，耗时却差了几个数量级**：光看工具名，无法预测下一次tool call会有多长

> 工具调用开始的那一刻，引擎就要决定 **KV 留不留、留多久**。立刻删，短调用吃亏；一直留，长调用吃亏；又没法预知这一次是长是短。如何选？

---
layout: two-cols
---

# 背景：引擎眼中的 Agent

## LLM看到的序列

- 请求结束 → 空窗（工具调用）→ **同前缀、更长的新请求**
- LLM 步 1.3–5.2s；工具步 8ms（`cat`）到 14s（`pytest`），跨三个数量级（Fig 2）

## 默认做法: end-of-turn eviction驱逐

- 一个 turn：**每次 LLM 调用都是一个独立请求**
- vLLM/SGLang：请求结束后变成**可驱逐**的缓存
- 显存空闲时下一轮还能命中，**一有新请求排队，这块显存就按 LRU 被分走**
- 多轮对话里合理（人打字要几十秒）
- agent 下一轮往往几秒内就回来，**刚删掉的 cache 马上又要重建**

>**剩余 token 随步数下降**：越靠后的 program 越快结束 → program 级 FCFS ≈ 最短剩余时间优先（SRTF），**保序有价值**

::right::
## trace 统计（GPT-5，各 100 条）

| 数据集                        | 轮数 (mean, std) | 工具耗时 ms (mean, std) | 每程序 token 数 (mean, std) |
| -------------------------- | -------------- | ------------------- | ----------------------- |
| SWE-Bench (mini-swe-agent) | (10.9, 2.1)    | (925, 3550)         | (70126, 19732)          |
| BFCL v4 (Web Search)       | (6.3, 2.3)     | (1923, 2133)        | (93256, 68687)          |

- **工具耗时均值 < 2s**：钉在显存里等它回来，量级上可行
- **标准差 ≥ 均值**：重尾，**大多数调用很短、少数极长**，均值没法当预测量
- **每程序 7–9 万 token**：重建和占用都很贵



---
layout: two-cols
---

# 动机：驱逐有两笔代价

## ① 重建代价（存储层）

- 保住：只需 prefill 新增的工具结果（远小于历史上下文）
- 被驱逐：前面几万 token（**所有历史 reasoning 和 tool call**）要重新 prefill，或从 CPU/SSD reload
- 可离线 profile；**异步 offload 已把它压到接近 0**

![Figure 4](./public/images/fig04-queueing-delay.jpg){.h-55}

*Figure 4：开启 CPU offload 后每个 program 的累计排队时间。InferCept（红）只算第 ① 笔，reload 近乎免费后几乎不保留 KV，曲线与 vLLM（蓝）基本重合*


::right::

## ② 重新排队延迟（调度层）

- 请求回来时显存已被别人占走，要排队等运行中的请求让位
- 无法离线测量，**每轮付一次**，随轮数线性累积
![Figure 1](./public/images/fig01-failure-modes.jpg){.h-60}
 *Figure 1：现有agent-serving系统的两种主要故障模式。红色方块表示由次优调度及 KV-缓存管理导致的额外开销：即使采用 CPU卸载，agent在经历 KV-缓存淘汰后仍会面临队列延迟*


---

# 问题归结：要留，但不能无限留

回到实际场景图，把现有做法放到两类工具调用上：

| 策略         | 代表              | 短调用（图中开头几次）                                  | 长调用（图中后段那次）               |
| ---------- | --------------- | -------------------------------------------- | ------------------------- |
| 请求结束即可驱逐   | vLLM / SGLang   | ✗ 重建 + 重新排队，**每轮付一次**                        | ✓ 显存及时让出                  |
| 按重建代价决定是否 pin，pin 则留到下一轮到达 | InferCept | ✗ offload 让 reload 近乎免费，判定"不值得留"，照样排队（Fig 4） | ✗ 一旦 pin 就**无界**，整段白占显存，堆满会死锁 |
| 理想         | –               | ✓ 留                                          | ✓ 放                       |

"理想"做不到：同一工具内部也重尾，最慢 10% 占总延迟 **52.5%**（BFCL `fetch_url`）/ **94.1%**（SWE `cd`），事先分不出这一次是快是慢。
*注：SWE 的工具名取 bash 块首词，`cd repo && pytest` 也记为 `cd`，这条尾部可能部分来自分类粒度。*

> [!IMPORTANT] 问题归结
> 要**有界地留**：留，但不能无限留。**留多久？** 见下一节。

---
layout: toc
active: 2
---

---
layout: two-cols
cols: 2fr 3fr
---

# 为什么是 TTL

## 最优保留策略的三条要求（§4）

1. **马上复用**：留住 KV，省 prefill / reload
2. **多轮连续**：少重新排队，保住 program 顺序
3. **鲁棒**：长调用、失败调用不能无限占显存

> **TTL**（Time-to-live存活时间）= KV 在 GPU 内停留的**最长时长 τ**。1、2 靠"留"，3 靠"到期即放"。

## 老抽象，新域

|       | 传统 TTL            | KV cache TTL           |
| ----- | ----------------- | ---------------------- |
| 场景    | DNS / CDN / 分布式缓存 | 推理引擎内的 GPU 显存          |
| 管什么   | 语义新鲜度             | 显存占用与排队                |
| 条目关系  | 互相独立              | 经显存压力、调度公平强耦合          |
| τ 从哪来 | 人工配置              | 按工具、按请求在线计算            |
| 到期后果  | 回源重新取             | 重建prefill + 重新排队reload |

::right::

![Figure 6](./public/images/fig06-ttl-tradeoff.jpg){.h-25}

*Figure 6：TTL 的双边惩罚（红虚线 = TTL 到期）*

## 两种结局：无界等待 → 有界等待

- **命中**（工具耗时 t ≤ τ）：下一轮直接复用 KV 并优先调度，**省 prefill/reload + 重新排队**
- **未命中**（t > τ）：到期自动驱逐，照付重建与排队，但**最多白占 τ**，不会堆满显存死锁
- 对应实际场景图：开头的短调用全部命中；后段那次长调用到 τ 就放手

## 双边惩罚：τ 必须算

- **τ 太短**：工具没回 KV 就被驱逐，**占用付了、收益没拿到**
- **τ 太长**：长调用期间整段钉住显存，挡住别人、拉低吞吐
- 两个极端即现有做法：vLLM ≈ **τ = 0**，InferCept pin 后 ≈ **τ = ∞**

> [!TIP] τ 由三样东西决定，下一页统一折算成时间
> 工具耗时分布 𝓟、重建代价 Prefill-Reload、保序价值 𝓣·η

<style>
.col-left p, .col-left li, .col-right p, .col-right li { font-size: 14.5px !important; line-height: 1.45 !important; }
.col-left h2, .col-right h2 { font-size: 17px !important; margin: 0.15em 0 0.25em !important; }
.col-left table { font-size: 13px !important; margin: 0.2em 0 0 !important; }
.col-left th, .col-left td { padding: 3px 6px !important; }
.col-left blockquote { margin: 0.35em 0 0.45em !important; padding: 0.3em 0.7em !important; }
.col-right .markdown-alert { margin: 0.35em 0 0 !important; padding: 0.3em 0.8em !important; }
.col-right .markdown-alert .markdown-alert-title { font-size: 14.5px; }
</style>

---
layout: two-cols
---

# 效用模型：成本、收益都折算成时间

<p class="lead">统一用<b>时间</b>度量，即所有 program 总 JCT 的增减。Benefit 假设下一轮在 τ 内到达，没赶上的情况见下页 𝓟(τ, f)。</p>

## 成本：占着显存，挡住别人

$$
\text{Cost}(\tau, r) = \frac{\text{MemUsage}(r)}{\mathcal{M}} \times \tau
$$

- MemUsage（r）：请求r 的 KV 显存占用；𝓜：活跃请求r平均占用
- 比值 = 被挡住的**平均请求数 n**：pin τ 秒 ≈ n 个请求各多等 τ
- 假设：需要保留时等待队列总有足够请求，阻塞真实发生

## 收益 ①：CacheMissCost（存储层）

$$
\begin{aligned}
\text{Benefit}(r) &= \text{CacheMissCost}(r) + \text{OutofOrderCost}(r) \\
\text{CacheMissCost}(r) &= \frac{\text{MemUsage}(r)}{\mathcal{M}} \times \text{Prefill-Reload}(r)
\end{aligned}
$$

- Prefill-Reload：关 offload 取 **prefill 时间**，开则取 **reload 时间**
- 离线 profile：prefill 按上下文长度拟合二次曲线，reload 用实测带宽

## 收益 ②：OutofOrderCost（调度层）

- 被驱逐后回来要**重新排队**，等别人腾显存。reload 再便宜这笔也还在，**InferCept 缺的就是这一项**

::right::

## 保序值多少：记忆性因子 η

- 取决于剩余步数是否随进度**可预测地减少**；k 为已服务轮数，N 为总轮数

$$
\eta = -\text{Corr}(k,\ N-k)
$$

| 轮数分布 | η | 含义 |
|---|---|---|
| 固定轮数 | 1 | 保序 ≈ 短作业优先，pin 可消除排队 |
| 几何分布 | 0 | 无记忆，剩余期望恒定，保序无益 |
| 极端长尾 | < 0 | 越跑剩越多，应频繁切换（未观察到） |

$$
\text{OutofOrderCost}(r) = \frac{\mathcal{𝓣}}{\mathcal{M}} \times \text{MemUsage}(r) \times \eta
$$

- 将**每单位上下文的平均等待时间**记为𝓣/𝓜
- 𝓣：**历史请求的平均排队延迟**
- 考虑**乘MemUsage（r）** 是因为大上下文要等更多显存腾出，更难调度
- η = 1 时恰为该 program 重回队列的等待；

> [!TIP] 三项共享因子 n = MemUsage(r)/𝓜
> Cost = n·τ，CacheMissCost = n·Prefill-Reload，OutofOrderCost = n·𝓣·η，下一页求 τ\* 时 n 直接消去

<style>
.col-left p, .col-left li, .col-right p, .col-right li { font-size: 14.5px !important; line-height: 1.45 !important; }
.col-left h2, .col-right h2 { font-size: 17px !important; margin: 0.2em 0 0.25em !important; }
.col-left .katex-display, .col-right .katex-display { margin: 0.2em 0 !important; font-size: 0.85em !important; }
.col-left, .col-right { min-width: 0; }
.col-left p.lead { margin: 0 0 0.4em !important; padding: 0.3em 0.7em; background: var(--gdut-primary-light); border-left: 4px solid var(--gdut-primary); border-radius: 3px; }
.col-left p.lead b { color: var(--gdut-primary); }
.col-right table { font-size: 13px !important; margin: 0.1em 0 0.2em !important; }
.col-right th:nth-child(1), .col-right td:nth-child(1) { white-space: nowrap; }
.col-right .markdown-alert .markdown-alert-title { font-size: 14.5px; }
.col-right th, .col-right td { padding: 2px 6px !important; }
.col-right th:nth-child(2), .col-right td:nth-child(2) { white-space: nowrap; text-align: center; }
.col-right .markdown-alert { margin: 0.3em 0 0 !important; padding: 0.3em 0.8em !important; }
</style>

---
layout: two-cols
---

# τ\* 求解：优化阈值，不预测点值

## 目标：期望净收益最大（式 1）

$$
\tau^* = \arg\max_\tau\ \mathcal{P}(\tau, f)\times\text{Benefit}(r) - \text{Cost}(\tau, r)
$$

- 确定**τ* 最优 TTL 值**，以最大化保留 KV 缓存的预期净收益
- 𝓟(τ, f)：下一个工具 f 在 τ 内返回的概率。**命中才拿到 Benefit，Cost 按 τ 全额付**

## 通过消去 n = MemUsage（r）/𝓜（式 2）

$$
\tau^* = \arg\max_\tau\ \mathcal{P}(\tau, f)\cdot\underbrace{\big(\mathcal{𝓣}\cdot\eta + \text{Prefill-Reload}(r)\big)}_{B：\text{一次命中省下的时间}} - \tau
$$

- 式 1 = n·【𝓟·(Prefill-Reload + 𝓣η) − τ】，n > 0 不改变 argmax
- **τ\* 与请求大小无关**，在线只需额外维护 𝓣 和 𝓟。 

## 𝓟：工具 f 历史耗时的经验 CDF
由于无法预知工具调用时长，故基于历史数据 $S[f]$ 的经验分布来估算概率 $𝓟(\tau, f)$：

$$
\mathcal{𝓟}(\tau, f) = \frac{1}{|S[f]|}\sum_{t \in S[f]} \mathbb{I}[t \le \tau]
$$

 - S = 全部工具调用记录，S【f】 = 工具 f 的记录
 - I【·】 为指示函数。最后，枚举 S【f】中的所有唯一工具调用时长（含 τ=0）作为候选值，选取期望奖励最高者求解式(2)


::right::

## 为什么优化阈值，而不是预测点值

- **点值预测不可靠**：工具耗时重尾（std ≥ mean），均值不能代表"这一次"
- **只需 CDF 形状**：延长 τ 值不值，看新增命中率 × Benifit 是否大于新增的 τ
- **自适应**：Benifit 大（排队重、重建贵）→ τ\* 覆盖更长的尾；Benifit 小（𝓣≈0 且开 offload）→ τ\* → 0，不 pin
- **错了有兜底**：落在 τ\* 之外的长尾直接放弃，最多白占 τ\*
## 冷启动：数据不够就退到更粗的估计

  解 τ* 需要工具 f 的经验 CDF 𝓟(τ,f)，样本太少则不可信。故按样本量分三层回退:
  （设K=100=样本量门槛，𝓣 初始化为0）：
  - `|S[f]| > K`：用工具 f 专属 CDF —— 最准
  - `|S[f]| ≤ K < |S|`：退到全局 CDF 𝓟(τ, f_any)，丢工具区分度换样本量
  - `|S| ≤ K`：无数据可用，退到固定 τ_default —— 假设耗时 ~ Exp(1)、η = 1，
    代入同一模型解得 τ_default = ln B ≈ 1~2s（即消融中的 Static TTL）

> [!TIP] 在线维护
> - 就这两个值𝓣，S【f】。虽然Prefill-Reload依赖离线 profile，但很便宜（每硬件×模型 <10 分钟）

<style>
.col-left p, .col-left li, .col-right p, .col-right li { font-size: 14.5px !important; line-height: 1.45 !important; }
.col-left h2, .col-right h2 { font-size: 17px !important; margin: 0.2em 0 0.25em !important; }
.col-left, .col-right { min-width: 0; }
.col-left .katex-display { margin: 0.2em 0 !important; font-size: 0.85em !important; }
.col-right .markdown-alert { margin: 0.3em 0 0 !important; padding: 0.3em 0.8em !important; }
.col-right .markdown-alert .markdown-alert-title { font-size: 14.5px; }
</style>

---
layout: two-cols
cols: 3fr 2fr
---

# Algorithm 1：调度主循环

```text {all|4-5|10-12|15-18|16|19|20-21|26}{lines:true}
Function OnRequestArrive(r):
  Q ← Q ∪ {r};  id ← program ID of r
  if id is a seen program then
    (f, t) ← tool-call info from r
    S[f] ← S[f] ∪ {t}
Function OnRequestFinish(r):
  if r is the last request of its program then
    free KV cache used by r
  else
    f  ← next tool to be called after r
    id ← program ID of r
    P[id] ← CalcTTL(r, S[f])       ▷ 即 τ* 求解
Function Schedule():
  while Q is not empty do
    for each id in P.keys do
      if now > P[id] and id ∉ Q.programs then
        free KV cache used by id's last request
        P ← P \ {id}
    r ← argmax_{r'∈Q} CalcPriority(r', P)
    if r cannot fit into memory then
      break
    else
      Q ← Q \ {r}
      issue r to running
      id ← program ID of r
      if id ∈ P.keys then P ← P \ {id}
```

::right::

<p class="algo-note">全局状态：等待队列Q； TTL 映射P（记录被pin住的程序及其TTL）；历史tool call记录S，其中S[ f ]表示tool f 的已记录tool call信息</p>

<div class="algo-steps">
  <div class="algo-step" :class="{ active: $clicks === 1 }"><span class="ln">4–5</span><div><b>记录耗时</b>：下一轮到达时才把 t 记入 S[f]，t 是服务端测的相邻请求间隔</div></div>
  <div class="algo-step" :class="{ active: $clicks === 2 }"><span class="ln">10–12</span><div><b>按下一个工具算 TTL</b>：r 的输出就是那次 function call，结束时已知 f</div></div>
  <div class="algo-step" :class="{ active: $clicks === 3 }"><span class="ln">15–18</span><div><b>惰性过期</b>：没有定时器，只在 Schedule 里检查</div></div>
  <div class="algo-step" :class="{ active: $clicks === 4 }"><span class="ln">16</span><div><b>过期且不在队列才释放</b>：下一轮已到、还在排队的，超时也不放</div></div>
  <div class="algo-step" :class="{ active: $clicks === 5 }"><span class="ln">19</span><div><b>优先级</b>：见下页三级排序</div></div>
  <div class="algo-step" :class="{ active: $clicks === 6 }"><span class="ln">20–21</span><div><b>放不下就 break</b>：不回填，严格保序；死锁靠驱逐规则兜底</div></div>
  <div class="algo-step" :class="{ active: $clicks === 7 }"><span class="ln">26</span><div><b>调度即 unpin</b>：TTL 只覆盖工具空窗</div></div>
</div>

<style>
.col-left pre { font-size: 11px !important; line-height: 1.4 !important; }
.col-left .slidev-code-line-numbers .slidev-code code .line::before {
  width: 1.4em;
  margin-right: 1em;
  color: #9ca3af;
}
.algo-note { font-size: 12px !important; line-height: 1.5 !important; color: #666; margin: 4px 0 8px !important; }
.algo-steps { display: flex; flex-direction: column; gap: 5px; }
.algo-step {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 6px;
  border-left: 3px solid transparent;
  border-radius: 3px;
  font-size: 13.5px;
  line-height: 1.45;
  transition: background 0.2s, border-color 0.2s;
}
.algo-step .ln {
  flex: none;
  min-width: 3.4em;
  padding: 1px 4px;
  border-radius: 3px;
  background: #eef2f7;
  color: #555;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  text-align: center;
}
.algo-step.active {
  border-left-color: var(--gdut-primary);
  background: var(--gdut-primary-light);
}
.algo-step.active .ln {
  background: var(--gdut-primary);
  color: #fff;
}
</style>

---
layout: two-cols
---

# 调度与系统实现

## Figure 7：一轮请求在系统里怎么走

![Figure 7](./public/images/fig07-system-overview.jpg){.h-40}

<p class="fig-note">蓝 = Agent 客户端，灰 = Continuum（vLLM 内），紫 = Handler，蓝绿 = GPU 显存；黑图钉 = TTL 内被 pin 的 KV 块，白图钉 = 已过期</p>

1. **LLM Request →**：请求挂上 `program_id`，进入原调度循环
2. **Tokens & Tool Info ↑**：完成时 Handler 解析工具名；下一轮到达时用服务端时间差记下这次工具耗时
3. **Tool Call Prediction ↓**：按该工具经验 CDF 算出 τ\*
4. **TTL →**：若τ\* > 0 就 pin，记下 now + τ\*，不释放 KV；若τ\* = 0 ，不 pin，立即释放 KV
5. **LLM Response ←**：客户端跑工具，结果进 Context，发下一轮
6. **Priority Queue**：下一轮凭 pin 排前、复用 KV；**Unpin ←** 过期才释放

::right::

## 等待队列的三级优先级（§4.3）

1. **被抢占**的请求：沿用原引擎，最先恢复
2. **TTL 内 pinned** 的下一轮：保多轮连续性
3. **program 级**到达时间：同类内 FCFS，老 program 不被新 program 插队

## Pin / Unpin 细节（§5.2）

- 每个调度步开头跑 `unpin_requests()`：**TTL 过期且同 program 没有请求在等待队列**才 unpin，防止下一轮已到、还没排上就被驱逐
- program 最后一轮结束时，主动释放它剩余的 pin
- **死锁**：显存被 pin 占满时队首放不下，pin 又在等队列里的下一轮。此时按 program 到达**最晚**依次驱逐 pin 直到队首放得下，被驱逐者重新排队

## 实现（§5.3）

- vLLM 上约 **1k 行 Python**；Handler 是独立类，只在请求到达 / 完成时调用三个函数：`func_call_finish`、`update_tool_call_time`、`set_up_ttl`
- 工具识别：OpenAI schema 取 `name`；SWE-Bench 取 bash 块第一个词
- 离线 profile：prefill 按上下文长度拟合二次曲线 + CPU↔GPU 带宽，每对"硬件×模型" < 10 分钟

<style>
.col-left, .col-right { min-width: 0; }
.col-left h2, .col-right h2 { font-size: 17px !important; margin: 0.15em 0 0.2em !important; }
.col-left li, .col-right li { font-size: 14px !important; line-height: 1.45 !important; }
.col-right li { line-height: 1.4 !important; }
.col-left p:has(> img) { margin: 0 !important; text-align: center; }
.gdut-content p.fig-note { margin: 2px 0 4px !important; font-size: 12.5px !important; line-height: 1.4 !important; color: #666; text-align: center; }
.col-left ol, .col-right ol, .col-right ul { margin-top: 0 !important; margin-bottom: 0.2em !important; }
</style>

---
layout: toc
active: 3
---

---

# 实验设置与端到端结果

| 负载（GPT-5 采 trace，Poisson 到达回放） | 模型 / 硬件 | Baseline |
|---|---|---|
| SWE-Bench（mini-swe-agent）、BFCL v4 Web Search、OpenHands | Llama-3.1-8B / 70B、Gemma-3-12B；A100 / H100 / B200 | vLLM 0.10.2、+ LMCache offload、Autellix（PLAS）、InferCept（后两者为作者在 vLLM 上复现） |

<Legend :items="['ours', 'vllm', 'autellix']" />

<div class="e2e-figs">
<div>

![SWE-Bench](./public/images/fig08-swebench-llama8b-b200.jpg){.h-36}

<p class="fig-cap"><b>SWE-Bench</b>：0.13 JPS 时 Autellix ~3700s ＞ vLLM ~2000s ＞ <b>Ours ~1200s</b></p>
</div>
<div>

![BFCL](./public/images/fig08-bfcl-llama8b-b200.jpg){.h-36}

<p class="fig-cap"><b>BFCL</b>：5 JPS 时 vLLM ~318s ＞ Autellix ~293s ＞ <b>Ours ~213s</b></p>
</div>
</div>

<p class="fig-note">Figure 8（共 8 张子图，分别是【Llama 70B，4×B200】，【Llama 8B，
1×B200】，【Llama 8B，1×A100】，【Gemma 12B，1×A100】，区别是模型与硬件不同，故此处取【 Llama-8B ， 1×B200 】两张；未开 offload，故无 InferCept）。横轴 JPS = 每秒到达的 agent 任务数，纵轴 = 平均 JCT</p>

<div class="e2e-notes">

> 全部配置下延迟降 **1.12×–3.66×**，吞吐升 **1.10×–3.22×**。低负载时三条线重合，**差距只在显存争用时拉开**。JPS 比常规 serving 论文低，因为一个 agent 任务要发 10 次以上 LLM 请求

> [!WARNING] 橙线的符号反转：SWE 上最差，BFCL 上第二
> Autellix（PLAS）假设"已经跑得越久，剩得越多"，优先服务新 program。SWE 轮数稳定（10.9 ± 2.1，η≈1），假设正好反了；BFCL 轮数更分散（6.3 ± 2.3），才部分成立。这正是 η 要刻画的

</div>

<style>
.gdut-content table { font-size: 13px !important; margin: 0 0 2px !important; }
.gdut-content th, .gdut-content td { padding: 3px 8px !important; line-height: 1.4; }
.e2e-figs { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.e2e-figs p:has(> img) { margin: 0 !important; }
.gdut-content p.fig-cap { margin: 0 !important; font-size: 14px !important; text-align: center; line-height: 1.4 !important; }
.gdut-content p.fig-cap b { color: var(--gdut-primary); }
.gdut-content p.fig-note { margin: 2px 0 4px !important; font-size: 12.5px !important; line-height: 1.4 !important; color: #666; text-align: center; }
.e2e-notes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.e2e-notes blockquote, .e2e-notes .markdown-alert { margin: 0 !important; padding: 0.35em 0.8em !important; }
.e2e-notes p { font-size: 14px !important; line-height: 1.45 !important; }
</style>

---
layout: two-cols
---

# 收益来源：排队延迟，且随轮数累积

## 开启 CPU offload（Fig 10）

<Legend :items="['ours', 'vllm:vLLM + offload', 'autellix:Autellix+', 'infercept']" />

![Figure 10](./public/images/fig10-swebench-offload-llama8b-b200.jpg){.h-46}

<p class="fig-note">SWE-Bench / Llama-8B / 1×B200；所有 baseline 都挂 LMCache（DRAM 200GB/GPU）</p>

- 0.13 JPS：Autellix+ ~1870s，vLLM ~1800s，InferCept ~1650s，**Ours ~1130s**
- 比 InferCept 快约 **1.45×**，比 vLLM 快约 **1.6×**：InferCept 省了 reload，**没省下排队**
- Autellix 的优势在 offload 下消失；Continuum 的收益**与 offload 正交**

::right::

## 轮数扩展（Fig 14）

<p class="fig-legend-note">柱色：<b style="color:#2ca02c">绿 Ours</b> · <b style="color:#1f77b4">蓝斜线 vLLM</b> · <b style="color:#ff7f0e">橙斜线 Autellix</b> · <b style="color:#d62728">红点 InferCept</b>；柱顶数字 = 相对 Ours 的倍数</p>

![Figure 14](./public/images/fig14-turn-scaling.jpg){.h-44}

<p class="fig-note">SWE trace 重复 1×–5×（10.9 → 50.6 轮），token 按比例缩小；0.13 JPS，DRAM 200GB</p>

- Ours 稳定在 ~1000–1100s，**不随轮数增长**
- baseline 全部恶化：vLLM 1.6× → **3.7×**，Autellix 1.7× → 2.5×，InferCept 1.4× → 2.2×
- 直接验证"每轮付一次排队"；局限：总 token 被固定，只测了轮数效应
- 其余敏感性：P90/P95（Fig 11）、batch size 与 chunk 256–4096（Fig 13）、SSD 400G/800G（Fig 15）下优势均保持

<style>
.col-left, .col-right { min-width: 0; }
.col-left h2, .col-right h2 { font-size: 18px !important; margin: 0.1em 0 0.2em !important; }
.col-left li, .col-right li { font-size: 14px !important; line-height: 1.45 !important; }
.col-left p:has(> img), .col-right p:has(> img) { margin: 0 !important; }
.gdut-content p.fig-note { margin: 0 0 4px !important; font-size: 12.5px !important; line-height: 1.4 !important; color: #666; text-align: center; }
.gdut-content p.fig-legend-note { margin: 2px 0 4px !important; font-size: 13px !important; line-height: 1.35 !important; text-align: center; }
</style>

---
layout: two-cols
cols: 3fr 2fr
---

# 消融与真实部署

## 消融（Fig 16）：每步只加一个组件

<Legend :items="['vllm', 'fcfs:+ Program FCFS', 'static:+ Static TTL', 'ours:完整方法']" />

<div class="abl-figs">

![Figure 16a](./public/images/fig16a-ablation-swebench.jpg){.h-42} ![Figure 16b](./public/images/fig16b-ablation-bfcl.jpg){.h-42}

</div>

<p class="fig-note">左：SWE-Bench　右：BFCL（Llama-8B）；纵轴平均 JCT (s)。表中数据读自最高负载点</p>

| 配置 | 新增组件 | SWE | BFCL |
|---|---|---|---|
| vLLM | 请求级 FCFS，请求结束即驱逐 | 1950s | 310s |
| + Program FCFS | 按 program 首轮到达排序 | 1640s | 270s |
| + Static TTL | 固定 $\tau_{\text{default}}$（冷启动值） | 1170s | 226s |
| 完整方法 | 成本模型 + 按工具经验 CDF | 1170s | 210s |

> 收益主要来自 **"turn 之间不驱逐" + program 级排序**；成本模型 + 经验 CDF 只在 BFCL 上多带来约 7%，SWE 上与 Static TTL 重合

::right::

## 真实分布式 SWE-Agent（Fig 12）

<Legend :items="['ours', 'sglang', 'dynamo']" />

![Figure 12a](./public/images/fig12a-real-swe-delay.jpg){.h-40}

<p class="fig-note">H100 testbed，SWE-Bench-Verified 500 题；注意紫色在这里是 SGLang，不是 Static TTL</p>

- vs **SGLang**：高负载 ~440s vs ~660s，**1.5×**；但 ~0.3 JPS 时 Ours 反而更慢（~100s vs ~50s）
- vs **Dynamo**（1P1D）："8.18×"只来自 JPS≈0.5 一个点；≥ 1.5 JPS 基本打平
- Pass rate（Fig 12b）：Ours 6.9% ≈ SGLang 7.0%，Dynamo 3.2%。Dynamo 的超时任务按 15 分钟截断、记为失败，**其延迟曲线因此偏低**
- 调度开销 0.96ms，vLLM 0.95ms（Table 4）

<style>
.col-left, .col-right { min-width: 0; }
.col-left h2, .col-right h2 { font-size: 18px !important; margin: 0.1em 0 0.2em !important; }
.col-left li, .col-right li, .col-left blockquote p { font-size: 14px !important; line-height: 1.45 !important; }
.col-right li { font-size: 13.5px !important; line-height: 1.42 !important; }
.col-left p:has(> img), .col-right p:has(> img) { margin: 0 !important; }
.col-left table { font-size: 13px !important; margin: 2px 0 6px !important; }
.col-left th, .col-left td { padding: 2px 7px !important; line-height: 1.4; }
.col-left blockquote { margin: 0 !important; padding: 0.35em 0.8em !important; }
.gdut-content p.fig-note { margin: 0 0 4px !important; font-size: 12.5px !important; line-height: 1.4 !important; color: #666; text-align: center; }
.col-right ul { margin-top: 0 !important; }
</style>

---
layout: toc
active: 4
---

---
layout: two-cols
cols: 2fr 3fr
---

# 总评：优点与不足

## 优点

- **问题选得准**：挖出先前工作漏掉的重新排队延迟；Figure 4（InferCept ≈ vLLM）的动机实验干净有力
- **抽象正确**："TTL + 经验 CDF 阈值"，重尾下优化分位点而不是预测均值
- **最硬的结果**：Figure 14，JCT 对轮数基本平坦
- **工程可落地**：vLLM 上约 1k 行、开源；调度开销与 vLLM 持平；与 CPU offload 正交

> **一句话**：问题和抽象都对，工程可落地；但收益主要来自"不驱逐 + program 级排序"，成本模型更像锦上添花。

::right::

## 不足

| 不足 | 要点 |
|---|---|
| 消融削弱叙事 | SWE-Bench 上 Static TTL ≈ 完整方法 |
| 成本模型有偏差 | ① Cost 按完整 τ 收费，而非 E[min(t, τ)]<br>② MemUsage/𝓜 在 Cost（被阻塞请求数）与 OutofOrderCost（单位上下文等待）里口径不一<br>③ 假设队列总是满的；η 没有在线测 |
| 估计量自反馈 | 𝓣 只从被驱逐请求统计、初值 0：pin 越多样本越少，offload 下起步可能不 pin |
| 排队期 pin 无上界 | TTL 只限"等工具"；回到队列后的 pin 仅靠死锁预防兜底，未量化 |
| 数字宣称夸大 | "over 8×" 来自 Dynamo 单点，且只有延迟没有吞吐；对 SGLang 只有 1.5× |
| 评测覆盖不足 | baseline 自行复现；工具均值都 < 2s；ThunderAgent 数字取自原文，非同环境 |
| 设计空间被跳过 | 没和抢占式调度比：TTL-pin 是否只是无抢占调度器的变通？ |

<style>
.col-left, .col-right { min-width: 0; }
.col-left li, .col-left blockquote p { font-size: 15.5px !important; line-height: 1.6 !important; }
.col-left li { margin-bottom: 0.6em !important; }
.col-left blockquote { margin-top: 0.8em !important; }
.col-right table { font-size: 13.5px !important; margin: 0 !important; width: 100%; }
.col-right th, .col-right td { padding: 3px 8px !important; line-height: 1.45 !important; vertical-align: top; }
.col-right th:first-child, .col-right td:first-child { white-space: nowrap; font-weight: 700; }
</style>

---
layout: two-cols
---

# 值得做的点

## 第一梯队：改动小，审稿人会问

1. **条件变量细化**：工具名 → (工具名, 参数特征)。同名工具呈双峰，单个 τ 只能服务一个峰；只改 `S[f]` 的键
2. **实测 η**：在两个 workload 上测 −Corr(k, N−k)，按 agent 类型分桶
3. **负载两端的行为**：JPS 从空载扫到过载，验证成本模型的自限性

> [!TIP] 负结果也能写
> 方向 1 若特征没用，反而说明"有界 TTL 不能被更好的预测替代"

::right::

## 第二、三梯队

4. **TTL过期软着陆**：GPU → DRAM → SSD 逐层退，每层一个 τ\*
5. **长工具 workload 评测**：text-to-SQL、human-in-the-loop、慢外部 API。纯评测，最适合切入
6. **厘清与 prefix caching 的关系**：baseline 是否开 APC，决定收益归因
7. **TTL-pin vs 抢占式调度**的正面对比
8. 过期抖动、τ 在飞可调、并行工具调用下 `P[id]` 的语义

---

# 推广：τ\* 背后的五个隐含假设

<div class="gen-formula">

$$
\tau^* = \arg\max_\tau\ \overbrace{\underbrace{\mathcal{P}(\tau, f)}_{\color{#c8161d}\mathbf{2}}\cdot\Big(\mathcal{T}\cdot\underbrace{\eta}_{\color{#c8161d}\mathbf{5}} + \underbrace{\text{Prefill-Reload}(r)}_{\color{#c8161d}\mathbf{3}}\Big)}^{\color{#c8161d}\mathbf{1}}\ \underbrace{-\ \tau}_{\color{#c8161d}\mathbf{4}}
$$

</div>

<div class="gen-assume">
  <div><span class="no">1</span><b>收益项</b>只算一次复用</div>
  <div><span class="no">2</span><b>𝓟</b>复用者只有本 program 下一轮</div>
  <div><span class="no">3</span><b>Prefill-Reload</b>下一轮是前缀扩展，整段可复用</div>
  <div><span class="no">4</span><b>−τ</b>只有"留在 GPU / 丢掉"两态</div>
  <div><span class="no">5</span><b>η</b>保序价值只看轮数</div>
</div>

<div class="gen-arch">
<div class="arch">

![ReAct](./public/images/react简单图.png)

<p class="cap"><span class="tag ok">基线</span>Continuum 的设定：Model ↔ Tool 单链循环，全部成立</p>
</div>
<div class="arch">

![Reflection](./public/images/Reflection简单图.png)

<p class="cap"><span class="tag">①②⑤</span>Critic 复用同一前缀，一份 KV 多个复用者；终止未知</p>
</div>
<div class="arch">

![Plan & Execute](./public/images/Plan&Execute简单图.png)

<p class="cap"><span class="tag">⑤③</span>Plan 给出剩余步数；Replan 重组 prompt，前缀断开</p>
</div>
<div class="arch">

![MultiAgent](./public/images/MultiAgent简单图.png)

<p class="cap"><span class="tag">②③</span>多个 Executor 共享 Planner 前缀，各自上下文不同</p>
</div>
</div>

<style>
.gen-formula { margin: -6px 0 0; }
.gen-formula .katex-display { margin: 0 !important; }
.gen-formula .katex { font-size: 1.05em; }
.gen-assume {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  margin: 4px 0 8px;
}
.gen-assume > div {
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--gdut-primary-light);
  font-size: 12.5px;
  line-height: 1.4;
  color: #333;
}
.gen-assume .no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-right: 4px;
  border-radius: 50%;
  background: var(--gdut-red);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  vertical-align: 1px;
}
.gen-assume b { color: var(--gdut-primary-dark); font-size: 13px; margin-right: 4px; }
.gen-arch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 20px;
}
.gen-arch .arch p { margin: 0 !important; }
.gen-arch .arch img { height: 138px; margin: 0 auto; object-fit: contain; }
.gen-arch .arch .cap {
  font-size: 13px !important;
  line-height: 1.4 !important;
  color: #444;
  text-align: center;
}
.tag {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 3px;
  background: var(--gdut-red);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}
.tag.ok { background: #5a8f3c; }
</style>

---

# 推广：打破假设之后能做什么

<p class="gen-legend">① 单次复用　② 单复用者　③ 前缀扩展　④ 两态存储　⑤ 保序只看轮数</p>

<table class="gen-table">
  <thead>
    <tr><th>类别</th><th>设计</th><th>打破</th><th>现象</th><th>值得做的点</th></tr>
  </thead>
  <tbody>
    <tr>
      <td rowspan="4" class="cat">控制流</td>
      <td>Reflection / 树搜索</td><td class="br">①②⑤</td>
      <td>同一前缀多个复用者（自我批评、ToT、best-of-N、RL rollout）；终止未知</td>
      <td>在<b>分叉点 pin</b>，Benefit ≈ E[子请求数]·B；η → 0</td>
    </tr>
    <tr>
      <td>Plan &amp; Execute</td><td class="br">⑤③</td>
      <td>剩余步数已知；Replan 重组 prompt</td>
      <td><b>真 SRTF</b>、按 plan 预热 𝓟(τ, f)、从 plan 抽 DAG</td>
    </tr>
    <tr>
      <td>并行工具调用（ReWOO）</td><td class="br">𝓟 形状</td>
      <td>空窗由最慢的那个工具决定</td>
      <td>𝓟 取 <b>max 分布</b>；<code>P[id]</code> 按批次定义</td>
    </tr>
    <tr>
      <td>Multi-Agent</td><td class="br">②③</td>
      <td>多 agent 并发，<code>P[id]</code> 一对一失效；子 agent 对父是超长工具调用</td>
      <td>OutofOrderCost × <b>下游阻塞因子</b>；父 agent τ = 0</td>
    </tr>
    <tr>
      <td rowspan="3" class="cat">上下文<br>与组件</td>
      <td>Context Engineering</td><td class="br">③</td>
      <td>压缩 / 裁剪后前缀失配</td>
      <td><b>压缩感知 pin</b>（τ = 0）、block 对齐、chunk 级 TTL</td>
    </tr>
    <tr>
      <td>Memory</td><td class="br">③④</td>
      <td>检索内容插入中段；复用间隔从秒到小时</td>
      <td><b>多时间尺度 TTL</b>：GPU 秒 / DRAM 十秒 / SSD 小时</td>
    </tr>
    <tr>
      <td>Skill</td><td class="br">①②</td>
      <td>静态块被多个 program 反复复用，E[复用次数] ≫ 1</td>
      <td>退化为<b>跨 program 共享缓存</b>；需位置无关缓存</td>
    </tr>
  </tbody>
</table>

> Continuum 解的是 **单次 × 单复用者 × 前缀 × 单层** 这一个角上的特例，每种架构对应一般问题的另一个角。

<style>
.gen-legend {
  margin: -4px 0 6px !important;
  font-size: 13px !important;
  color: #666;
  text-align: center;
}
.gen-table { font-size: 13.5px !important; }
.gen-table th, .gen-table td { padding: 4px 8px !important; line-height: 1.4; vertical-align: middle; }
.gen-table th:nth-child(1) { width: 8%; }
.gen-table th:nth-child(2) { width: 17%; }
.gen-table th:nth-child(3) { width: 8%; }
.gen-table th:nth-child(4) { width: 33%; }
.gen-table td.cat {
  background: var(--gdut-primary-light) !important;
  color: var(--gdut-primary-dark);
  font-weight: 700;
  text-align: center;
}
.gen-table td.br { color: var(--gdut-red); font-weight: 700; text-align: center; white-space: nowrap; }
.gen-table b { color: var(--gdut-primary); }
.gen-table tbody tr:nth-child(even) { background: transparent; }
</style>

---
layout: two-cols
---

# 研究计划

## 选题优先级

1. **近期：方向 1 + 方向 5**。参数特征细化 𝓟(τ, f)，并在长工具 workload 上验证。打的是同一个软肋（工具时长不可预测），一个改预测、一个补评测，正负结果都能写
2. **中期：Context Engineering × KV 保留**。压缩感知 pin + block 对齐压缩，可直接在 vllm-continuum 上实现
3. **备选**：Skill 全局共享缓存层；从 plan 抽 DAG

> [!NOTE] thesis 级框架
> 把"KV 保留"推广到**多复用者、多次复用、chunk 粒度、多存储层**的一般问题，每种架构是它的一个实例

::right::

## 本地复现（4060 8GB + WSL2）

 1. Continuum是开源的，直接建在 vLLM 上，tool-call handler 是模块化的。
 2. 我本地vLLM 已经跑通，量化 7B 模型上复现小规模实验（改 TTL、关掉 OutofOrderCost 项做ablation）
3. 加 program FCFS + 固定 TTL，复现消融曲线（几十行 patch）
4. 核实 baseline 是否开了 APC（方向 6）

> 仓库：github.com/Hanchenli/vllm-continuum

---
layout: end
---
