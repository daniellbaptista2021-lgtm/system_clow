import ExcelJS from 'exceljs';

async function criarPlanilha() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Números');
    
    // Adicionar cabeçalho
    worksheet.getCell('A1').value = 'Número';
    worksheet.getCell('A1').font = { bold: true };
    
    // Adicionar números de 1 a 10
    for (let i = 1; i <= 10; i++) {
        worksheet.getCell(`A${i + 1}`).value = i;
    }
    
    // Ajustar largura da coluna
    worksheet.getColumn('A').width = 15;
    
    // Salvar arquivo
    await workbook.xlsx.writeFile('numeros_1_a_10.xlsx');
    console.log('Planilha criada com sucesso!');
}

criarPlanilha().catch(console.error);