import ExcelJS from 'exceljs';

async function criarPlanilha() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Dados');

    // Definir cabeçalhos
    worksheet.columns = [
        { header: 'Produto', key: 'produto', width: 20 },
        { header: 'Quantidade', key: 'quantidade', width: 15 },
        { header: 'Preço', key: 'preco', width: 15 }
    ];

    // Adicionar dados fake
    const dados = [
        { produto: 'Notebook Dell', quantidade: 10, preco: 2500.00 },
        { produto: 'Mouse Logitech', quantidade: 25, preco: 89.90 },
        { produto: 'Teclado Mecânico', quantidade: 15, preco: 299.99 },
        { produto: 'Monitor 24"', quantidade: 8, preco: 899.00 },
        { produto: 'Webcam HD', quantidade: 12, preco: 159.90 }
    ];

    dados.forEach(item => {
        worksheet.addRow(item);
    });

    // Formatar coluna de preço como moeda
    worksheet.getColumn('preco').numFmt = 'R$ #,##0.00';

    // Estilizar cabeçalho
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
    };

    // Salvar arquivo
    await workbook.xlsx.writeFile('teste_final_a.xlsx');
    console.log('Planilha teste_final_a.xlsx criada com sucesso!');
}

criarPlanilha().catch(console.error);