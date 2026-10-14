window.__ModuleLoader__.load({
	id: "dsh-auto-create-folder",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		var NS = "auto-folder";

		/** General Settings row: title + description + Switch. */
		function AutoFolderRow({ useEnabled, setEnabled, t }) {
			const enabled = useEnabled((value) => value);
			return react.createElement("div", {
				style: {
					borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
					justifyContent: "space-between",
					alignItems: "center",
					gap: "24px",
					padding: "16px 0",
					display: "flex"
				}
			},
				react.createElement("div", null,
					react.createElement("div", { style: { fontSize: "14px", lineHeight: "20px" } }, t("title")),
					react.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", marginTop: "4px", fontSize: "12px", lineHeight: "18px" } }, t("description"))
				),
				react.createElement(primitives.Switch, {
					checked: enabled,
					label: t("title"),
					onChange: (next) => { setEnabled(next).catch(() => {}); }
				})
			);
		}

		var inject = ["slots", "locale", "configForms"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh: {
					title: "自动创建文件夹",
					description: "在创建新文件前，按任务内容自动新建文件夹并把文件归入其中"
				},
				en: {
					title: "Auto-create folder",
					description: "Create a folder named after the task before creating new files"
				}
			}), "auto-folder: dictionaries");

			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "auto-folder",
				order: 16,
				locale: NS,
				inject: () => {
					const form = ctx.configForms.get("auto-folder");
					return {
						hooks: {
							enabled: {
								getSnapshot: () => form.getSnapshot().value?.enabled ?? true,
								subscribe: (listener) => form.subscribe(listener)
							}
						},
						setEnabled: (enabled) => form.set("enabled", enabled)
					};
				}
			}, AutoFolderRow));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
