import { Download } from 'lucide-react'

export default function Contract() {
  return (
    <section className="section-padding bg-gray-50">
      <div className="container mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-4">
            Baixe o modelo e veja tudo que está incluído
          </h2>
          <p className="text-xl text-gray-600">
            Consulte o contrato com itens inclusos, regras de horário, limpeza e contato para dúvidas.
          </p>
        </div>
        
        <div className="max-w-md mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Download className="w-8 h-8 text-blue-600" />
            </div>
            <h3 className="text-xl font-semibold text-gray-900 mb-4">
              Contrato DF Festas
            </h3>
            <p className="text-gray-600 mb-6">
              Documento completo com todas as informações, regras e itens inclusos no aluguel.
            </p>
            <a 
              href="/contratos/df-festas-contrato.pdf" 
              className="btn-primary inline-flex items-center gap-2"
              download
            >
              <Download size={20} />
              Baixar contrato em PDF
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}