---
description: 为 DSH 的第三方 OpenAI 兼容模型补全思考强度档位，并通过原生模型菜单选择。
kind: package-bundle
---

# DSH 第三方模型思考强度

中文 | [English](README.en.md)

## 简介

让第三方 OpenAI 兼容模型显示 DSH 原生的思考强度选项。插件按提供商和模型 ID 匹配当前 DSH 安装包内的能力目录，也支持针对中转手动覆盖档位和参数值。可以单独使用；搭配 [dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider)，可以使用带渐变、粒子和动画的滑条。已在 DSH Desktop `0.2.1-rc.2` 验证。

## 目录

- [安装与使用](#use)
- [搭配炫酷滑条](#slider)
- [配置](#configuration)
- [实现与开发](#development)
- [相关项目](#related)
- [模型交互](#model-experience)
- [已知限制](#limitations)

-----

<a id="use"></a>
## 安装与使用

从 [Releases](https://github.com/yxccai/dsh-model-thinking/releases) 下载 `dsh-model-thinking-0.2.0.tgz`。在 DSH Desktop 的插件管理中添加这个本地安装包，然后完全退出并重新打开 DSH。它是独立插件，无需安装滑条插件。

点击聊天输入框里的模型名称 → 思考强度（Effort）→ 选择档位。选择应用于下一次请求；使用原生菜单就能调第三方模型的强度。

![仅安装本插件：使用 DSH 原生档位菜单](docs/screenshots/native-menu.png)

截图来自隔离的 DSH Web profile，模型名为本地测试别名，请求只发送到本机模拟网关。桌面版复用同一套模型菜单。

安装会增加 `dsh-model-thinking` profile 层。禁用或卸载后，模型恢复原先声明的能力；已有会话选过的档位仍由 DSH 保存，需要时选择 Default。插件只叠加运行时能力配置，不改写提供商配置文件、API 密钥或会话历史。

-----

<a id="slider"></a>
## 搭配炫酷滑条

希望操作更直观、界面更美观，可以另外安装 [Microqian2th/dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider)。它为原生思考强度选择器增加拖动滑条、渐变配色和星尘动画；安装方法以该项目说明为准。

| 插件 | 负责什么 |
| --- | --- |
| `dsh-model-thinking`（本项目） | 补全第三方模型支持的档位，提供中转参数覆盖规则。 |
| `dsh-codex-effort-slider`（可选） | 读取 DSH 已有档位，以带动画的滑条显示并操作。 |

两者是独立插件，没有合并，也没有强制依赖。本插件补全档位后，滑条会读取这些档位；仅保留本插件时，仍可使用 DSH 原生菜单。

![搭配滑条插件：Max 档位](docs/screenshots/with-slider.png)

已与滑条插件 `1.1.3` 联合验证五档和六档模型。截图中的滑条及视觉特效来自该项目，本仓库不包含它的代码。

-----

<a id="configuration"></a>
## 配置

默认启用自动匹配，无需手动填写档位。优先级是：模型显式声明（含禁用）→ 首条匹配的覆盖规则 → DSH 内置目录 → 显式设置的未知 GPT 回退档位。只补充缺少 `reasoningEfforts` 的 `models` 或 `modelOverrides`，支持 `openai-completions` 和 `openai-responses`。

需要为中转定制时，在所用 profile 的 `cordis.patch.yml` 中添加：

```yaml
- id: dsh-model-thinking
  config:
    autoCatalog: true
    defaultEfforts: []
    rules:
      - provider: my-gateway
        model: gpt-6-*
        efforts:
          low: low
          medium: medium
          high: high
          xhigh: xhigh
          max: ultra
```

`provider` 和 `model` 支持 `*` 通配符；`max: ultra` 仅是中转自定义参数的示例，只有中转要求 `ultra` 时才这样设置。规则值是实际发送的字符串，界面档位名可用 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。

| 设置 | 含义 |
| --- | --- |
| `autoCatalog` | 默认 `true`；从当前 DSH 随包目录匹配模型能力，下次启动读取已升级的目录。 |
| `defaultEfforts` | 默认 `[]`；仅为未知 GPT 型号显式配置回退档位，不是自动探测结果。 |
| `rules` | 默认 `[]`；按提供商和模型匹配档位及其请求参数值。 |
| `autoGpt` | 兼容旧配置的开关；设置后优先于 `autoCatalog`。 |

`off: none` 明确发送 `none`；`off: null` 表示省略参数，不保证关闭思考。界面的 Default 沿用中转默认值，也不等于关闭思考。模型自身的 `reasoningEfforts: false` 和有效的 `supportsReasoningEffort: false` 保持优先。

-----

<a id="development"></a>
## 实现与开发

需要 Node.js `>=22.19.0`。从源码构建：

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm pack --ignore-scripts
```

15 项单元测试覆盖目录匹配、五档与六档、未知型号、显式禁用、覆盖优先级和配置不可变性。GitHub Actions 执行类型检查、单元测试、构建和打包。

<details>
<summary>实现与本地集成测试</summary>

[cordis.patch.yml](cordis.patch.yml) 插入一个宿主插件；[src/index.ts](src/index.ts) 为 pi-ai 适配器的有效配置叠加能力声明。[src/catalog.ts](src/catalog.ts) 读取当前安装的 pi-ai 内置模型目录；[src/capabilities.ts](src/capabilities.ts) 处理优先级和映射。插件不包含客户端界面，档位保存和请求序列化仍由 DSH 负责。

`scripts/test-installed.mjs` 使用真实 Loader、LLM 服务和 pi-ai 适配器，验证请求参数、配置更新、卸载恢复及已准备请求。`scripts/test-web.mjs` 启动隔离的真实 Web profile，用系统 Edge 检查原生菜单、滑条及提交参数。它们需要本机安装的 DSH，不在通用 CI 中运行，也不调用付费模型。

两个脚本的首个参数为安装包的 `app.asar/dsh` 目录，需要使用桌面版 Electron 的 `ELECTRON_RUN_AS_NODE=1` 模式执行。Web 测试支持 `DSH_TEST_MODEL`、`DSH_TEST_EFFORT`、`DSH_TEST_SLIDER_PATH` 和 `DSH_TEST_PLUGIN_PATH` 环境变量；目前五档/六档断言使用脚本中指定的测试型号。

</details>

-----

<a id="related"></a>
## 相关项目

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：宿主应用。
- [dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider)：可选的滑条与视觉效果插件。
- [MIT License](LICENSE) 与 [第三方许可](THIRD_PARTY_NOTICES.md)。

<a id="model-experience"></a>
## 模型交互

本插件不添加工具、系统提示词或模型调用。它通过 DSH 现有路径传递所选推理强度；Chat Completions 和 Responses 的序列化由 pi-ai 适配器负责。

<a id="limitations"></a>
## 已知限制

自动匹配是读取本地能力目录，不是向中转实时询问档位。未知或存在歧义的型号默认不增加档位；目录中的能力不能保证中转完整转发参数，特殊限制需要覆盖规则。模型改名、使用别名或目录过旧时，也可能无法自动匹配。

已验证运行时为 DSH Desktop `0.2.1-rc.2`，兼容性仍受其 Cordis、pi-ai 导出和配置机制影响。其他 DSH 版本需另行验证。插件启用和禁用会重新加载 pi-ai 适配器；已经准备好的请求保留开始时的参数。

### 开发备注

<details>
<summary>维护者工作记录</summary>

无。

</details>
