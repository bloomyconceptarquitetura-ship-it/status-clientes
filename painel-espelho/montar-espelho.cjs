#!/usr/bin/env node
// lora ref:espelho-bloomy
/*
  Gera o "espelho" do painel Bloomy: uma página HTML estática, só leitura,
  protegida por senha simples, publicada no GitHub Pages. Os dados vêm de uma
  pasta local (DADOS_DIR, normalmente baixada do Google Drive antes de rodar
  este script) e são lidos com EXATAMENTE a mesma lógica de leitura do
  servidor.cjs de verdade (montarEstado/montarBloco/lerCartao/...), pra nunca
  divergir de como o painel real interpreta os arquivos.

  Uso: node montar-espelho.cjs <pasta-de-dados> <arquivo-html-de-saida>
  Ex.:  node montar-espelho.cjs ./dados ../painel/index.html

  A pasta de dados precisa ter, na raiz: config.json, como-trabalho.md, e uma
  subpasta memoria/ com a mesma estrutura de sempre (projetos/, agenda/,
  clientes/, equipe/, financeiro.md, marketing.md, resumo-bloom.md...).

  Saída: um único arquivo .html autocontido. Os dados vão embutidos
  criptografados (AES-256-GCM, chave derivada da senha da equipe via
  PBKDF2-SHA256, 210000 iterações) — sem a senha certa, o "view-source" só
  mostra bytes aleatórios, nunca os dados em claro.
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DADOS_DIR = path.resolve(process.argv[2] || "./dados");
const SAIDA = path.resolve(process.argv[3] || "./index.html");
const BASE = DADOS_DIR; // equivalente ao BASE do servidor.cjs de verdade

// ---------- funções de leitura (portadas 1:1 do servidor.cjs real) ----------

function lerConfig() {
  return JSON.parse(fs.readFileSync(path.join(BASE, "config.json"), "utf8"));
}

function glob(padrao) {
  const abs = path.join(BASE, padrao);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  if (!fs.existsSync(dir)) return [];
  if (!base.includes("*")) return fs.existsSync(abs) ? [abs] : [];
  const ext = base.replace("*", "");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext) && !f.startsWith("."))
    .map((f) => path.join(dir, f))
    .sort();
}

function lerCartao(abs) {
  const texto = fs.readFileSync(abs, "utf8");
  const linhas = texto.split("\n");
  let titulo = path.basename(abs, ".md");
  const campos = {};
  const ordem = [];
  for (const linha of linhas) {
    const mH1 = linha.match(/^#\s+(.+?)\s*$/);
    if (mH1 && titulo === path.basename(abs, ".md")) titulo = mH1[1];
    const mCampo = linha.match(/^\s*[-*]\s*\*\*(.+?):\*\*\s*(.*)$/);
    if (mCampo) {
      const chave = mCampo[1].trim();
      campos[chave] = mCampo[2].trim();
      ordem.push(chave);
    }
  }
  return { arquivo: path.relative(BASE, abs), titulo, campos, ordem };
}

function lerChecklist(rel) {
  const abs = path.join(BASE, rel);
  if (!fs.existsSync(abs)) return { arquivo: rel, itens: [] };
  const linhas = fs.readFileSync(abs, "utf8").split("\n");
  const itens = [];
  linhas.forEach((linha, i) => {
    const m = linha.match(/^\s*[-*]\s*\[([ xX])\]\s+(.*)$/);
    if (m) itens.push({ linha: i, feito: m[1].toLowerCase() === "x", texto: m[2] });
  });
  return { arquivo: rel, itens };
}

const RE_ATUAL = /\s*\*\*\(atual\)\*\*|\s*\(atual\)/i;

function lerPassos(rel) {
  const abs = path.join(BASE, rel);
  if (!fs.existsSync(abs)) return { arquivo: rel, passos: [] };
  const linhas = fs.readFileSync(abs, "utf8").split("\n");
  const passos = [];
  linhas.forEach((linha, i) => {
    const m = linha.match(/^\s*[-*]\s+(.+)$/);
    if (m && !/^\[[ xX]\]/.test(m[1])) {
      let texto = m[1];
      let atual = false;
      if (RE_ATUAL.test(texto)) {
        atual = true;
        texto = texto.replace(RE_ATUAL, "").trim();
      }
      passos.push({ linha: i, texto, atual });
    }
  });
  return { arquivo: rel, passos };
}

function lerStats(rel) {
  const abs = path.join(BASE, rel);
  if (!fs.existsSync(abs)) return { arquivo: rel, numeros: [] };
  const linhas = fs.readFileSync(abs, "utf8").split("\n");
  const numeros = [];
  linhas.forEach((linha, i) => {
    const m = linha.match(/^\s*[-*]\s*\*\*(.+?):\*\*\s*(.*)$/);
    if (m) numeros.push({ linha: i, rotulo: m[1].trim(), valor: m[2].trim() });
  });
  return { arquivo: rel, numeros };
}

function lerTexto(rel) {
  const abs = path.join(BASE, rel);
  if (!fs.existsSync(abs)) return { arquivo: rel, conteudo: "", titulo: "", corpo: "" };
  const conteudo = fs.readFileSync(abs, "utf8");
  const m = conteudo.match(/^#[ \t]+(.*)\r?\n\r?\n?([\s\S]*)$/);
  if (m) return { arquivo: rel, conteudo, titulo: m[1].trim(), corpo: m[2] };
  return { arquivo: rel, conteudo, titulo: "", corpo: conteudo };
}

// checklist por etapa de projeto: no espelho não recriamos arquivos (é só
// leitura), então só lê se já existir — sem "garantir" (sem gravar nada).
function lerChecklistEtapaSeExistir(arquivoProjetoRel, sigla) {
  const nomeProjeto = path.basename(arquivoProjetoRel, ".md");
  const rel = path.join("memoria/projetos/_checklists-etapas", nomeProjeto + "-" + slug(sigla) + ".md");
  return lerChecklist(rel);
}

function slug(s) {
  return (
    (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "novo"
  );
}

function montarHojeSemana(cfg) {
  const hs = cfg.hojeSemana;
  if (!hs) return null;
  const campoData = hs.campoData || "Data";
  const cartoes = glob(hs.fonte).map(lerCartao);
  const eventos = cartoes.filter((c) => c.campos[campoData]);
  const semData = cartoes.filter((c) => !c.campos[campoData]);
  return { ...hs, eventos, semData };
}

function montarBloco(bloco) {
  if (bloco.tipo === "checklist") return { ...bloco, checklist: lerChecklist(bloco.arquivo) };
  if (bloco.tipo === "diagrama") return { ...bloco, diagrama: lerPassos(bloco.arquivo) };
  if (bloco.tipo === "stats") return { ...bloco, stats: lerStats(bloco.arquivo) };
  if (bloco.tipo === "texto") return { ...bloco, texto: lerTexto(bloco.arquivo) };
  if (bloco.tipo === "tarefasPessoa") {
    const fontes = Array.isArray(bloco.fontes) ? bloco.fontes : bloco.fonte ? [bloco.fonte] : [];
    const pessoa = (bloco.pessoa || "").toLowerCase();
    let todos = [];
    fontes.forEach((f) => {
      todos = todos.concat(glob(f).map(lerCartao));
    });
    const relevantes = pessoa
      ? todos.filter((c) => {
          const texto = (c.titulo + " " + Object.values(c.campos).join(" ")).toLowerCase();
          return texto.includes(pessoa);
        })
      : todos;
    return { ...bloco, cartoes: relevantes };
  }
  const cartoes = glob(bloco.fonte).map(lerCartao);
  if (bloco.tipo === "funil" || bloco.tipo === "kanban") {
    const relevantes = cartoes.filter((c) => c.campos[bloco.campoEstagio]);
    const estagios =
      Array.isArray(bloco.estagios) && bloco.estagios.length
        ? bloco.estagios
        : [...new Set(relevantes.map((c) => c.campos[bloco.campoEstagio]))];
    if (bloco.tipo === "kanban") {
      relevantes.forEach((c) => {
        c.checklistsEtapa = {};
        estagios.forEach((sigla) => {
          c.checklistsEtapa[sigla] = lerChecklistEtapaSeExistir(c.arquivo, sigla);
        });
      });
    }
    return { ...bloco, estagios, cartoes: relevantes };
  }
  if (bloco.tipo === "lista") {
    const relevantes = bloco.campoTag ? cartoes.filter((c) => c.campos[bloco.campoTag]) : cartoes;
    return { ...bloco, cartoes: relevantes };
  }
  if (bloco.tipo === "calendario") {
    const campoData = bloco.campoData || "Data";
    const eventos = cartoes.filter((c) => c.campos[campoData]);
    const semData = cartoes.filter((c) => !c.campos[campoData]);
    return { ...bloco, eventos, semData };
  }
  return { ...bloco, cartoes };
}

function hojeISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

function montarEstado() {
  const cfg = lerConfig();
  const setores = cfg.setores.map((setor) => {
    const blocos = setor.blocos.map((bloco) => montarBloco(bloco));
    return { ...setor, blocos };
  });
  const resumoBloom = cfg.resumoBloom ? lerTexto(cfg.resumoBloom.arquivo) : null;
  const hojeSemana = montarHojeSemana(cfg);
  return { config: cfg, setores, hojeSemana, resumoBloom, geradoEm: new Date().toISOString(), geradoEmISO: hojeISO() };
}

// ---------- criptografia (senha simples, cliente-side) ----------
// PBKDF2-SHA256 (210000 iterações) deriva uma chave AES-256-GCM a partir da
// senha da equipe. O HTML embute só o resultado cifrado + salt + iv; sem a
// senha certa, "ver código-fonte" não revela nada legível.

function criptografar(objeto, senha) {
  const texto = JSON.stringify(objeto);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const chave = crypto.pbkdf2Sync(senha, salt, 210000, 32, "sha256");
  const cifra = crypto.createCipheriv("aes-256-gcm", chave, iv);
  const cifrado = Buffer.concat([cifra.update(texto, "utf8"), cifra.final()]);
  const tag = cifra.getAuthTag();
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    dados: Buffer.concat([cifrado, tag]).toString("base64"),
  };
}

// ---------- montar e gravar ----------

function gerar() {
  const estado = montarEstado();
  const senha = estado.config.senhaEquipe || "";
  delete estado.config.senhaEquipe; // nunca embute a senha em claro
  const pacote = criptografar(estado, senha);

  const template = fs.readFileSync(path.join(__dirname, "template-espelho.html"), "utf8");
  const html = template.replace(
    "/*__PACOTE_CIFRADO__*/",
    "window.__PACOTE__ = " + JSON.stringify(pacote) + ";"
  );

  fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
  fs.writeFileSync(SAIDA, html);
  console.log("Espelho gerado em " + SAIDA + " (" + Buffer.byteLength(html) + " bytes)");
}

gerar();
