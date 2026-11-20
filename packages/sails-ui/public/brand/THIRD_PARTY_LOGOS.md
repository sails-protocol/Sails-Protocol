# Logos de terceiros (ativos e redes)

Logos usadas só para identificar o ativo ou a rede de um par do catálogo
(`src/lib/assetCatalog.ts`), sempre ao lado do nome escrito. Cada logo continua
sendo marca do seu dono; o uso aqui é nominativo e não indica parceria,
endosso ou suporte. Os arquivos estão como foram baixados: nenhum caminho,
cor ou proporção foi alterado.

## Origem

| Arquivo | Origem |
|---|---|
| `assets/btc.svg` | web3icons `raw-svgs/tokens/branded/BTC.svg` |
| `assets/usdt.svg` | web3icons `raw-svgs/tokens/branded/USDT.svg` |
| `assets/usdc.svg` | web3icons `raw-svgs/tokens/branded/USDC.svg` |
| `networks/bitcoin.svg` | web3icons `raw-svgs/networks/branded/bitcoin.svg` |
| `networks/ethereum.svg` | web3icons `raw-svgs/networks/branded/ethereum.svg` |
| `networks/polygon.svg` | web3icons `raw-svgs/networks/branded/polygon.svg` |
| `networks/base.svg` | web3icons `raw-svgs/networks/branded/base.svg` |
| `networks/arbitrum.svg` | web3icons `raw-svgs/networks/branded/arbitrum-one.svg` |
| `networks/ton.svg` | web3icons `raw-svgs/networks/branded/ton.svg` |
| `networks/tron.svg` | web3icons `raw-svgs/networks/branded/tron.svg` |
| `networks/solana.svg` | web3icons `raw-svgs/networks/branded/solana.svg` |
| `networks/liquid.svg` | Blockstream, kit oficial da Liquid: `Liquid Assets/liquid logos/liquid_emblem/liquid_emblem_on_transparent_rgb.svg` |

- web3icons: https://github.com/0xa3k5/web3icons, commit
  `172f57f38fca75007002a4d707e08f33d82ba3a5`, licença MIT (texto abaixo).
- Liquid: pacote https://design.blockstream.com/assets/pages/liquid/LiquidAssets.zip,
  ligado em https://design.blockstream.com/styleguide/branding/liquid-network,
  baixado em 2026-11-20. Nenhuma licença explícita para terceiros foi
  encontrada; uso nominativo, sempre ao lado do nome "Liquid".

Os 12 SVGs foram verificados: sem script, handler de evento, href externo ou
foreignObject. São carregados como `<img>`, então nada dentro deles executa.

## Regras de uso

- Não redesenhar, distorcer, recolorir, girar, nem aplicar sombra ou gradiente
  (guia da Blockstream: https://design.blockstream.com/styleguide/branding/logo;
  vale para todas as logos aqui).
- Logo sempre acompanhada do nome do ativo ou da rede; como a palavra está ao
  lado, a imagem é decorativa (`alt=""`).
- Quando uma logo escura some sobre a superfície escura, ela vai sobre uma
  pastilha neutra clara. Nunca se troca a cor da logo.

## Licença MIT (web3icons)

```
MIT License

Copyright (c) 2024 0xa3k5

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
