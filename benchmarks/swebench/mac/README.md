# Mac 本地 SWE-bench 环境

这些脚本在 Apple Silicon 上运行官方 SWE-bench 评分器和 x86_64 实例镜像，并以它们为准。Docker Desktop 负责 amd64 仿真；由于这台 Mac 的 Docker 虚拟机内存低于评分器建议值，harness 从单个 worker 开始。

基准测试自己的测试位于 `../test/`；使用 `bun run test:swebench` 与产品测试套件分开运行。

配置固定版本的 Python 3.12 环境：

```sh
bash benchmarks/swebench/mac/provision.sh
```

配置器会安装 `swebench==4.1.0` 和 `mini-swe-agent==2.4.5`，验证本地辅助工具，并写入 `environment.lock.json`。锁文件包含主机、Docker 和软件包元数据；不会读取 `.env` 或记录凭据。

运行 30 个实例的门禁前，先运行一个容量实例：

```sh
bash benchmarks/swebench/mac/gold-check.sh \
  --instance-id apache__druid-13704 \
  --output-dir benchmarks/swebench/.cache/gold-capacity
```

`official_image.py` 会向固定版本的 SWE-bench 软件包查询实例镜像键，再使用 `--platform linux/amd64` 拉取该镜像。在 Apple Silicon 上必须先执行此拉取；不带平台参数的 Docker 拉取会在评分器运行前选中错误的平台。评分器本身使用一个 worker 且不使用 harness 缓存。黄金检查器逐行评分，并使用 `--clean true`。测试活动评分则会按实例对所有实验组进行归类，各次调用使用 `--clean false`，随后只在该组完成后删除对应镜像，避免一个实验组删掉后续实验组所需的镜像。测试活动评分会在输出目录的 `images/` 文件夹下记录拉取的标签、不可变 Docker 镜像 ID、平台和大小。

检查容量指标后，运行已提交的测试清单：

```sh
bash benchmarks/swebench/mac/gold-check.sh
```

脚本会为每个实例打印一行；除非所有实例均成功解析，否则以非零状态退出。运行时输出保存在 `benchmarks/swebench/.cache/` 下。每行处理后，它只移除刚刚解析并拉取的那个官方实例镜像；不会调用范围宽泛的 Docker prune，也不会删除无关镜像或容器。只有明确希望用更多磁盘空间换取更快重跑时，才传入 `--keep-images`。

[`../fixtures/capacity-gold-report.json`](../fixtures/capacity-gold-report.json) 和 [`../fixtures/capacity-metrics.json`](../fixtures/capacity-metrics.json) 中的一实例验证证明，官方 x86_64 镜像可在仿真环境中通过单个 worker 解析。它不能证明尚待完成的 30/30 黄金门禁或 mini-swe-agent 复现测试已通过。
