export default function HowToReserve() {
  const steps = [
    {
      number: '1',
      title: 'Escolha a data',
      description: 'Veja disponibilidade na agenda e selecione o dia.'
    },
    {
      number: '2',
      title: 'Agende visita ou WhatsApp',
      description: 'Tire dúvidas e combine detalhes.'
    },
    {
      number: '3',
      title: 'Faça o PIX do sinal',
      description: 'Garanta a reserva rapidamente.'
    },
    {
      number: '4',
      title: 'Assine o contrato',
      description: 'Formalize e curta a festa.'
    }
  ]

  return (
    <section className="section-padding bg-white">
      <div className="container mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-4">
            Passo a passo para garantir sua data
          </h2>
        </div>
        
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {steps.map((step, index) => (
            <div key={index} className="text-center">
              <div className="w-16 h-16 bg-blue-600 text-white rounded-full flex items-center justify-center mx-auto mb-4 text-2xl font-bold">
                {step.number}
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-3">
                {step.title}
              </h3>
              <p className="text-gray-600">
                {step.description}
              </p>
            </div>
          ))}
        </div>
        
        <div className="text-center mt-12">
          <a href="https://wa.me/5521999999999" className="btn-secondary text-lg px-8 py-4">
            Precisa de ajuda? Fale conosco
          </a>
        </div>
      </div>
    </section>
  )
}