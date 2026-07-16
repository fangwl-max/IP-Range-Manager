# IP段管理平台

一个功能完整的IP段管理系统，用于管理IP段信息、供应商、ASN、续费时间、价格等数据。

## 功能特性

- ✅ IP段管理（添加、编辑、删除、查看）
- ✅ IP段供应商管理
- ✅ ASN信息管理
- ✅ IP段续费时间管理
- ✅ IP段价格/月管理
- ✅ 项目组管理（可自定义添加）
- ✅ 服务器位置管理（供应商+地区，可自定义添加）
- ✅ IP段被墙信息管理（伊朗、缅甸、土库曼、俄罗斯）
- ✅ 数据本地存储（localStorage）
- ✅ 响应式设计，支持表格横向滚动

## 技术栈

- React 18
- TypeScript
- Vite
- Ant Design 5
- Day.js

## 安装和运行

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

应用将在 http://localhost:8081 启动

### 外部访问配置

服务器已配置为允许外部主机访问。启动后，可以通过以下方式访问：

1. **本地访问**：http://localhost:8081
2. **局域网访问**：http://[本机IP地址]:8081
   - Windows: 在命令提示符中运行 `ipconfig` 查看本机IP地址
   - Linux/Mac: 在终端中运行 `ifconfig` 或 `ip addr` 查看本机IP地址

**注意事项**：
- 确保防火墙允许8081端口的入站连接
- Windows防火墙设置：控制面板 → Windows Defender 防火墙 → 高级设置 → 入站规则 → 新建规则 → 端口 → TCP → 8081 → 允许连接
- 如果无法访问，请检查防火墙设置和网络配置

### 构建生产版本

```bash
npm run build
```

### 预览生产版本

```bash
npm run preview
```

### 部署到服务器

详见 [DEPLOYMENT.md](./DEPLOYMENT.md)，支持 PM2、Docker、systemd 等方式。

## 使用说明

### 添加IP段

1. 点击"添加IP段"按钮
2. 填写以下信息：
   - IP段（例如：192.168.1.0/24）
   - 供应商
   - ASN（例如：AS12345）
   - 续费时间
   - 价格/月（元）
   - 被墙信息（可选，多选）
   - 项目组（可多选或输入新项目组）
   - 服务器位置（可添加多个，每个包含供应商和地区）

### 编辑IP段

1. 在表格中点击"编辑"按钮
2. 修改相关信息
3. 点击"确定"保存

### 删除IP段

1. 在表格中点击"删除"按钮
2. 确认删除操作

### 配置管理

1. 点击"配置管理"按钮
2. 可以添加新的项目组或供应商
3. 可以删除现有的项目组或供应商（点击标签的关闭按钮）

## 数据存储

所有数据存储在浏览器的 localStorage 中，包括：
- IP段数据
- 项目组数据
- 供应商数据

## 项目结构

```
├── src/
│   ├── components/          # 组件目录
│   │   └── IPManagement.tsx # IP管理主组件
│   ├── types/               # 类型定义
│   │   └── index.ts         # 类型和接口定义
│   ├── utils/               # 工具函数
│   │   └── storage.ts       # 本地存储工具
│   ├── App.tsx              # 应用主组件
│   ├── App.css              # 应用样式
│   └── main.tsx             # 应用入口
├── index.html               # HTML模板
├── package.json             # 项目配置
├── tsconfig.json            # TypeScript配置
├── vite.config.ts           # Vite配置
└── README.md                # 项目说明
```

## 浏览器支持

- Chrome (推荐)
- Firefox
- Safari
- Edge

## 许可证

MIT

