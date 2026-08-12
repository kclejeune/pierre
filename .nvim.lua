vim.opt.tabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.g.ale_fixers = {
	typescript = { "oxfmt" },
	javascript = { "oxfmt" },
	typescriptreact = { "oxfmt" },
	javascriptreact = { "oxfmt" },
	json = { "oxfmt" },
	jsonc = { "oxfmt" },
	css = { "oxfmt" },
	markdown = { "oxfmt" },
	html = { "oxfmt" },
	mdx = { "oxfmt" },
	conf = { "oxfmt" },
	lua = { "stylua" },
}

vim.g.ale_fix_on_save = 1

-- Hack to support tsgo until we can upgrade internally to 7
local project_root = vim.fs.root(0, { "pnpm-lock.yaml" }) or vim.fn.getcwd()
local tsgo = vim.fs.joinpath(project_root, "node_modules", ".bin", "tsgo")

if vim.fn.executable(tsgo) == 1 then
	vim.lsp.config("tsgo", {
		cmd = { tsgo, "--lsp", "--stdio" },
	})
	vim.defer_fn(function()
		vim.lsp.enable("tsgo", false)
		vim.lsp.enable("tsgo")
	end, 100)
end
