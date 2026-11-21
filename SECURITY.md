# 安全问题 / Security

请不要在公开 issue 里写安全漏洞的细节。请用本仓库 **Security › Report a vulnerability**（GitHub 私密漏洞报告）提交，写明受影响的提交号、复现步骤和影响。

本项目是实验性质的个人项目，没有承诺的响应时间，只修 `main` 分支。

Please do not describe a vulnerability in a public issue. Report it through **Security › Report a vulnerability** (GitHub private vulnerability reporting) in this repository, with the affected commit, the steps to reproduce it and its effect.

This is an experimental personal project. There is no promised response time, and fixes go to `main` only.

## 范围 / Scope

应用会在本机运行智能体内核、读取用户授权的桌面活动、保存模型服务凭据。和这些有关的问题都在范围内：凭据或观察内容泄露、绕过审批或窗口授权、本机 HTTP 接口被其他来源调用、角色包导入时的路径或代码执行问题。

The app runs agent kernels on your machine, reads the desktop activity you allow, and stores model-service credentials. Reports about these are in scope: leaked credentials or observed content, a bypass of an approval or a window grant, another origin calling the local HTTP interface, and path or code-execution problems in character-package import.
