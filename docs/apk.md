# 打包成 APK：能做到什么程度，怎么做到

## 先把结论说清楚

1. **这套系统的服务端没法装进 APK。** 数据库（SQLite）、DeepSeek 的 key、看板、催办，全都得跑在一台有公网地址的机器上。APK 只能当**客户端外壳**，它仍然依赖那个公网地址。所以「打包成 APK」= 换了个打开方式，不是换了个部署方式。
2. **这台机器现在编不出 APK。** 我查过了：没有 JDK、没有 Android SDK、没有 Gradle、没有 adb。真要从零编，要装 1.5–2 GB 的东西，首次 Gradle 构建还得联网拉依赖（国内经常卡）。
3. **但你已经有一个能用的替代品**：学生端已经是标准 PWA（manifest + service worker + 图标），Android Chrome 打开后「添加到主屏幕」，就会得到**带图标、全屏、能离线打开壳**的入口。效果和 APK 的 90% 一样，而且**扫码即用、不用装**。

## 三条路的对比

| 方案 | 学生要做什么 | 需要什么 | 耗时 | 我的评价 |
|---|---|---|---|---|
| **A. PWA（已做好）** | 扫码打开 → 菜单「添加到主屏幕」 | 无 | 已完成 | **推荐先用** |
| **B. TWA / PWABuilder 在线生成 APK** | 下载 APK 安装 | 永久域名 + HTTPS + `/.well-known/assetlinks.json` | 30 分钟 | 要真 APK 就走这条 |
| **C. Capacitor 本地构建** | 下载 APK 安装 | JDK 17 + Android SDK（~2 GB）+ Gradle | 1–2 小时 | 只在要上架/要原生能力时做 |

### A 已经完成了什么

- `web/public/manifest.webmanifest`（standalone、主题色、三档图标含 maskable）
- `web/public/sw.js`（`/api/**` 永不缓存；导航网络优先；`/assets/**` 缓存优先）
- 图标是脚本现算的 PNG（`node scripts/make-icons.mjs`），不依赖任何图像库
- 从主屏图标打开会**自动回到学生上次看的那份通知**（`lm.lastNotice`），不是空白页

装上去之后：图标在桌面、点开全屏无地址栏、断网也能打开壳并提示"连不上服务器"。

### B 怎么走（不需要本机 SDK）

1. 先把系统挂到**永久域名**上（见 [tunnel-options.md](tunnel-options.md) 第五节）
2. 打开 <https://www.pwabuilder.com>，输入你的网址，它会检测 manifest / SW / 图标
3. 选 Android → 下载 APK 包（它给的是 TWA 工程 + 签名配置）
4. 它会给一个 **SHA-256 签名指纹**，要求你放到
   `https://你的域名/.well-known/assetlinks.json`
5. 我已经在服务端留了口子，把指纹给我（或自己写进 `server/index.js`），一行就能生效

TWA 的好处：用的是你网站的真实内容，**没有第二份代码要维护**，改网站 APK 自动更新。

### C 要装什么（如果非要本地编）

```powershell
# 1) JDK 17
winget install --id EclipseAdoptium.Temurin.17.JDK

# 2) Android 命令行工具（sdkmanager + platform-tools + build-tools）
#    下载 commandlinetools-win-*.zip，解到 %LOCALAPPDATA%\Android\Sdk
#    然后 sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

# 3) Capacitor
npm i -D @capacitor/cli
npm i @capacitor/core @capacitor/android
npx cap init "LastMile" "cn.edu.swufe.lastmile" --web-dir=public
npx cap add android
npx cap open android      # 或者 cd android && gradlew assembleDebug
```

产物在 `android/app/build/outputs/apk/debug/app-debug.apk`。

**这一步的风险**：Gradle 首次同步要下 1 GB 依赖，国内网络经常超时；SDK 许可证要手动 `--licenses` 同意。**演示前一天不要做这件事。**

## 我的建议

1. **48h 实测期间不要折腾 APK**。用 PWA + 二维码图片，学生扫码就能用，扫码比装 APK 门槛低得多。
2. 演示时如果想展示"能装到桌面"，当场用手机 Chrome 演示「添加到主屏幕」，30 秒，比 APK 更有说服力。
3. 真要 APK：**先搞定永久域名**，然后走 PWABuilder（B），不要在自己电脑上装 SDK。

## 一句话

APK 解决的问题是「图标 + 不被微信拦」，**不是**「不用服务器」。而这两件事，PWA + 二维码图片已经解决了 90%。剩下的 10%（应用商店、脱离浏览器）对一个 36h 黑客松来说不值得。
