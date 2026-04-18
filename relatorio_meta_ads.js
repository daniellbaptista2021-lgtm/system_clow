import ExcelJS from 'exceljs';

async function gerarRelatorio() {
    const workbook = new ExcelJS.Workbook();
    
    // Aba 1: Resumo das Campanhas
    const wsResumo = workbook.addWorksheet('Resumo das Campanhas');
    
    // Cabeçalhos
    wsResumo.columns = [
        { header: 'Nome da Campanha', key: 'nome', width: 40 },
        { header: 'Status', key: 'status', width: 15 },
        { header: 'Objetivo', key: 'objetivo', width: 20 },
        { header: 'Orçamento Diário', key: 'orcamento_diario', width: 18 },
        { header: 'Orçamento Total', key: 'orcamento_total', width: 18 },
        { header: 'Criada em', key: 'criada', width: 20 },
        { header: 'Atualizada em', key: 'atualizada', width: 20 }
    ];
    
    // Dados das campanhas
    const campanhas = [
        {
            nome: 'ABO / SulAmerica / VD+FUN / 2026 - V2',
            status: 'PAUSADA',
            objetivo: 'ENGAJAMENTO',
            orcamento_diario: '-',
            orcamento_total: '-',
            criada: '08/04/2026',
            atualizada: '17/04/2026'
        },
        {
            nome: 'SulAmérica / Seguro de Vida / Andrômeda V2 / Abr26',
            status: 'PAUSADA',
            objetivo: 'ENGAJAMENTO',
            orcamento_diario: '-',
            orcamento_total: 'R$ 10.000,00',
            criada: '30/03/2026',
            atualizada: '07/04/2026'
        },
        {
            nome: '[ANDRÔMEDA] NIO Fibra - Engajamento WhatsApp - Mar/2026',
            status: 'PAUSADA',
            objetivo: 'ENGAJAMENTO',
            orcamento_diario: 'R$ 150,00',
            orcamento_total: '-',
            criada: '29/03/2026',
            atualizada: '09/04/2026'
        },
        {
            nome: 'Campanha / NIO Fibra / Março',
            status: 'PAUSADA',
            objetivo: 'ENGAJAMENTO',
            orcamento_diario: '-',
            orcamento_total: '-',
            criada: '24/03/2026',
            atualizada: '29/03/2026'
        },
        {
            nome: 'Campanha / ABO / NIO / 3 Posicionamentos',
            status: 'PAUSADA',
            objetivo: 'ENGAJAMENTO',
            orcamento_diario: 'R$ 150,00',
            orcamento_total: '-',
            criada: '12/03/2026',
            atualizada: '20/03/2026'
        },
        {
            nome: 'ABO / SulAmerica / VD+FUN / 2026',
            status: 'PAUSADA',
            objetivo: 'ENGAJAMENTO',
            orcamento_diario: '-',
            orcamento_total: '-',
            criada: '06/03/2026',
            atualizada: '14/04/2026'
        },
        {
            nome: 'NIO | WhatsApp | RJ | ABO | 03-2026',
            status: 'PAUSADA',
            objetivo: 'ENGAJAMENTO',
            orcamento_diario: '-',
            orcamento_total: '-',
            criada: '02/03/2026',
            atualizada: '12/03/2026'
        }
    ];
    
    campanhas.forEach(campanha => {
        wsResumo.addRow(campanha);
    });
    
    // Aba 2: Performance Abril 2026
    const wsPerformance = workbook.addWorksheet('Performance Abril 2026');
    
    wsPerformance.columns = [
        { header: 'Campanha', key: 'campanha', width: 40 },
        { header: 'Impressões', key: 'impressoes', width: 15 },
        { header: 'Cliques', key: 'cliques', width: 12 },
        { header: 'Gasto (R$)', key: 'gasto', width: 15 },
        { header: 'CTR (%)', key: 'ctr', width: 12 },
        { header: 'CPC (R$)', key: 'cpc', width: 12 },
        { header: 'CPP (R$)', key: 'cpp', width: 12 },
        { header: 'Alcance', key: 'alcance', width: 15 },
        { header: 'Frequência', key: 'frequencia', width: 12 }
    ];
    
    const performance = [
        {
            campanha: 'ABO / SulAmerica / VD+FUN / 2026 - V2',
            impressoes: '74.970',
            cliques: '2.624',
            gasto: 'R$ 3.126,23',
            ctr: '3,50%',
            cpc: 'R$ 1,19',
            cpp: 'R$ 103,48',
            alcance: '30.212',
            frequencia: '2,48'
        },
        {
            campanha: 'SulAmérica / Seguro de Vida / Andrômeda V2 / Abr26',
            impressoes: '34.950',
            cliques: '721',
            gasto: 'R$ 1.213,27',
            ctr: '2,06%',
            cpc: 'R$ 1,68',
            cpp: 'R$ 56,88',
            alcance: '21.330',
            frequencia: '1,64'
        },
        {
            campanha: '[ANDRÔMEDA] NIO Fibra - Engajamento WhatsApp - Mar/2026',
            impressoes: '18.126',
            cliques: '187',
            gasto: 'R$ 610,27',
            ctr: '1,03%',
            cpc: 'R$ 3,26',
            cpp: 'R$ 49,29',
            alcance: '12.381',
            frequencia: '1,46'
        },
        {
            campanha: 'ABO / SulAmerica / VD+FUN / 2026',
            impressoes: '720',
            cliques: '16',
            gasto: 'R$ 34,94',
            ctr: '2,22%',
            cpc: 'R$ 2,18',
            cpp: 'R$ 50,86',
            alcance: '687',
            frequencia: '1,05'
        }
    ];
    
    performance.forEach(dados => {
        wsPerformance.addRow(dados);
    });
    
    // Aba 3: Análise e Recomendações
    const wsAnalise = workbook.addWorksheet('Análise e Recomendações');
    
    wsAnalise.columns = [
        { header: 'Métrica', key: 'metrica', width: 30 },
        { header: 'Valor', key: 'valor', width: 20 },
        { header: 'Status', key: 'status', width: 15 },
        { header: 'Recomendação', key: 'recomendacao', width: 50 }
    ];
    
    const analises = [
        {
            metrica: 'Total de Campanhas',
            valor: '7 campanhas',
            status: '⚠️ ATENÇÃO',
            recomendacao: 'Todas as campanhas estão pausadas. Reativar as de melhor performance.'
        },
        {
            metrica: 'Gasto Total (Abril)',
            valor: 'R$ 4.984,71',
            status: '✅ OK',
            recomendacao: 'Gasto controlado dentro do esperado.'
        },
        {
            metrica: 'Melhor CTR',
            valor: '3,50% (ABO V2)',
            status: '✅ EXCELENTE',
            recomendacao: 'Campanha ABO V2 tem ótimo engajamento. Considerar reativar.'
        },
        {
            metrica: 'Menor CPC',
            valor: 'R$ 1,19 (ABO V2)',
            status: '✅ EXCELENTE',
            recomendacao: 'Custo por clique muito competitivo na campanha ABO V2.'
        },
        {
            metrica: 'Total de Cliques',
            valor: '3.548 cliques',
            status: '✅ BOM',
            recomendacao: 'Bom volume de cliques, especialmente na campanha ABO V2.'
        },
        {
            metrica: 'Alcance Total',
            valor: '64.610 pessoas',
            status: '✅ BOM',
            recomendacao: 'Boa cobertura de audiência nas campanhas ativas.'
        }
    ];
    
    analises.forEach(analise => {
        wsAnalise.addRow(analise);
    });
    
    // Formatação
    [wsResumo, wsPerformance, wsAnalise].forEach(ws => {
        ws.getRow(1).font = { bold: true };
        ws.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4472C4' }
        };
        ws.getRow(1).font.color = { argb: 'FFFFFFFF' };
    });
    
    // Salvar arquivo
    await workbook.xlsx.writeFile('./relatorio_meta_ads_abril_2026.xlsx');
    console.log('Relatório gerado com sucesso!');
}

gerarRelatorio().catch(console.error);