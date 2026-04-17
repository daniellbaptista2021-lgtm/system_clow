import Image from 'next/image'

export default function Hero() {
  return (
    <section className="pt-16 bg-gradient-to-br from-blue-50 to-green-50">
      <div className="container mx-auto px-4 py-16">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <h1 className="text-4xl lg:text-5xl font-bold text-gray-900 mb-6">
              DF Festas - Espaço completo com piscina para a sua festa
            </h1>
            <p className="text-xl text-gray-600 mb-8">
              Piscina, churrasqueira, pula-pula, som, Wi-Fi, área coberta e descoberta. 
              Tudo pronto para aniversários, confraternizações e eventos em Rio de Janeiro – RJ.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <a href="#agenda" className="btn-primary text-center">
                Ver agenda de datas
              </a>
              <a href="https://wa.me/5521999999999" className="btn-secondary text-center">
                Falar com atendente
              </a>
            </div>
            
            <div className="grid grid-cols-2 gap-6 mt-12">
              <div className="text-center">
                <div className="bg-blue-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-3">
                  <span className="text-2xl">🏊‍♀️</span>
                </div>
                <h3 className="font-semibold text-gray-900">Piscina</h3>
                <p className="text-sm text-gray-600">Adulto e infantil com área segura.</p>
              </div>
              <div className="text-center">
                <div className="bg-green-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-3">
                  <span className="text-2xl">🔥</span>
                </div>
                <h3 className="font-semibold text-gray-900">Churrasqueira</h3>
                <p className="text-sm text-gray-600">Fogão elétrico e área gourmet.</p>
              </div>
            </div>
          </div>
          
          <div className="relative">
            <div className="bg-white p-8 rounded-2xl shadow-xl">
              <Image
                src="/images/logo_pagina_principal.png"
                alt="Espaço DF Festas"
                width={500}
                height={400}
                className="w-full h-auto rounded-lg"
                priority
              />
            </div>
            <div className="absolute -bottom-6 -right-6 bg-blue-600 text-white p-4 rounded-lg shadow-lg">
              <p className="font-semibold">Endereço</p>
              <p className="text-sm">Rua Basílio de Brito, Cachambi</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}