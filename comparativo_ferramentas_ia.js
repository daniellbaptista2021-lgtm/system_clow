import ExcelJS from 'exceljs';

async function criarComparativo() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Comparativo Ferramentas IA');

    // Configurar colunas
    worksheet.columns = [
        { header: 'Característica', key: 'caracteristica', width: 25 },
        { header: 'Clow (System)', key: 'clow', width: 30 },
        { header: 'Claude Code', key: 'claude_code', width: 30 },
        { header: 'ChatGPT', key: 'chatgpt', width: 30 },
        { header: 'GitHub Copilot', key: 'copilot', width: 30 },
        { header: 'Cursor', key: 'cursor', width: 30 }
    ];

    // Dados comparativos
    const dados = [
        {
            caracteristica: 'Tipo de Ferramenta',
            clow: 'Agente autônomo com execução direta',
            claude_code: 'Assistente de código web',
            chatgpt: 'Chatbot conversacional',
            copilot: 'Autocomplete inteligente no IDE',
            cursor: 'IDE com IA integrada'
        },
        {
            caracteristica: 'Execução de Código',
            clow: '✅ Executa diretamente no servidor',
            claude_code: '❌ Apenas sugere código',
            chatgpt: '❌ Apenas sugere código',
            copilot: '❌ Apenas sugere código',
            cursor: '✅ Pode executar via terminal'
        },
        {
            caracteristica: 'Acesso a APIs Externas',
            clow: '✅ Acesso completo com credenciais',
            claude_code: '❌ Sem acesso direto',
            chatgpt: '❌ Sem acesso direto',
            copilot: '❌ Sem acesso direto',
            cursor: '⚠️ Limitado via extensões'
        },
        {
            caracteristica: 'Manipulação de Arquivos',
            clow: '✅ Lê, cria, edita arquivos reais',
            claude_code: '❌ Apenas visualiza código',
            chatgpt: '❌ Não manipula arquivos',
            copilot: '⚠️ Via IDE apenas',
            cursor: '✅ Manipula arquivos do projeto'
        },
        {
            caracteristica: 'Automação de Tarefas',
            clow: '✅ Automação completa end-to-end',
            claude_code: '❌ Sem automação',
            chatgpt: '❌ Sem automação',
            copilot: '❌ Sem automação',
            cursor: '⚠️ Limitada ao desenvolvimento'
        },
        {
            caracteristica: 'Integração com Serviços',
            clow: '✅ Meta Ads, n8n, Supabase, etc.',
            claude_code: '❌ Sem integrações',
            chatgpt: '⚠️ Plugins limitados',
            copilot: '⚠️ Via GitHub apenas',
            cursor: '⚠️ Extensões limitadas'
        },
        {
            caracteristica: 'Contexto de Projeto',
            clow: '✅ Acesso completo ao workspace',
            claude_code: '⚠️ Arquivos enviados pelo usuário',
            chatgpt: '❌ Sem contexto persistente',
            copilot: '✅ Contexto do repositório',
            cursor: '✅ Contexto completo do projeto'
        },
        {
            caracteristica: 'Linguagem de Resposta',
            clow: '🇧🇷 Português brasileiro nativo',
            claude_code: '🇺🇸 Inglês (tradução manual)',
            chatgpt: '🌍 Multilíngue',
            copilot: '🇺🇸 Inglês principalmente',
            cursor: '🌍 Multilíngue'
        },
        {
            caracteristica: 'Modelo de Preço',
            clow: 'Personalizado por uso',
            claude_code: 'Gratuito/Pro $20/mês',
            chatgpt: 'Gratuito/Plus $20/mês',
            copilot: '$10/mês individual',
            cursor: 'Gratuito/Pro $20/mês'
        },
        {
            caracteristica: 'Deploy e Hospedagem',
            clow: '✅ Deploy direto (Vercel, etc.)',
            claude_code: '❌ Sem deploy',
            chatgpt: '❌ Sem deploy',
            copilot: '❌ Sem deploy',
            cursor: '⚠️ Via terminal/extensões'
        },
        {
            caracteristica: 'Gerenciamento de Estado',
            clow: '✅ Sessões persistentes',
            claude_code: '⚠️ Sessão da conversa',
            chatgpt: '⚠️ Sessão da conversa',
            copilot: '❌ Sem estado',
            cursor: '✅ Estado do projeto'
        },
        {
            caracteristica: 'Debugging e Logs',
            clow: '✅ Logs em tempo real',
            claude_code: '❌ Sem debugging',
            chatgpt: '❌ Sem debugging',
            copilot: '⚠️ Via IDE apenas',
            cursor: '✅ Debugging integrado'
        },
        {
            caracteristica: 'Colaboração em Equipe',
            clow: '✅ Multi-agentes e equipes',
            claude_code: '❌ Individual apenas',
            chatgpt: '⚠️ Compartilhamento limitado',
            copilot: '✅ Colaboração via GitHub',
            cursor: '⚠️ Compartilhamento de projeto'
        },
        {
            caracteristica: 'Especialização',
            clow: 'Automação e operações técnicas',
            claude_code: 'Desenvolvimento web',
            chatgpt: 'Conversação geral',
            copilot: 'Autocomplete de código',
            cursor: 'IDE completo com IA'
        },
        {
            caracteristica: 'Curva de Aprendizado',
            clow: 'Baixa - linguagem natural',
            claude_code: 'Baixa - interface web',
            chatgpt: 'Muito baixa - chat simples',
            copilot: 'Média - integração IDE',
            cursor: 'Média - novo IDE'
        }
    ];

    // Adicionar dados
    dados.forEach(row => {
        worksheet.addRow(row);
    });

    // Estilizar cabeçalho
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '366092' }
    };

    // Estilizar dados
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
            row.eachCell((cell, colNumber) => {
                if (colNumber === 1) {
                    cell.font = { bold: true };
                    cell.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'F2F2F2' }
                    };
                }
                
                // Colorir símbolos
                if (cell.value && typeof cell.value === 'string') {
                    if (cell.value.includes('✅')) {
                        cell.font = { color: { argb: '008000' } };
                    } else if (cell.value.includes('❌')) {
                        cell.font = { color: { argb: 'FF0000' } };
                    } else if (cell.value.includes('⚠️')) {
                        cell.font = { color: { argb: 'FF8C00' } };
                    }
                }
                
                cell.border = {
                    top: { style: 'thin' },
                    left: { style: 'thin' },
                    bottom: { style: 'thin' },
                    right: { style: 'thin' }
                };
            });
        }
    });

    // Adicionar legenda
    const legendaRow = worksheet.addRow([]);
    worksheet.addRow(['Legenda:', '✅ Suporte completo', '⚠️ Suporte parcial', '❌ Sem suporte', '', '']);
    
    const legenda = worksheet.getRow(worksheet.rowCount);
    legenda.font = { italic: true, size: 10 };

    // Salvar arquivo
    await workbook.xlsx.writeFile('./comparativo_ferramentas_ia.xlsx');
    console.log('Planilha criada com sucesso!');
}

criarComparativo().catch(console.error);