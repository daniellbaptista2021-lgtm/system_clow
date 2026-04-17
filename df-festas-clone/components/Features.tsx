export default function Features() {
  const features = [
    {
      icon: '🏊‍♀️',
      title: 'Piscina',
      description: 'Piscina com área segura para todos curtirem.'
    },
    {
      icon: '🔥',
      title: 'Churrasqueira',
      description: 'Churrasqueira pronta para o seu churrasco.'
    },
    {
      icon: '🎪',
      title: 'Pula-pula',
      description: 'Diversão garantida para as crianças.'
    },
    {
      icon: '🚿',
      title: 'Dois banheiros',
      description: 'Conforto para todos os convidados.'
    },
    {
      icon: '🔊',
      title: 'Caixa de som',
      description: 'Som disponível para animar a festa.'
    },
    {
      icon: '📶',
      title: 'Wi-Fi',
      description: 'Conexão estável para você e seus convidados.'
    }
  ]

  return (
    <section id="estrutura" className="section-padding bg-gray-50">
      <div className="container mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-4">
            Curta sua festa da melhor forma
          </h2>
        </div>
        
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <div key={index} className="feature-card text-center">
              <div className="text-4xl mb-4">{feature.icon}</div>
              <h3 className="text-xl font-semibold text-gray-900 mb-3">
                {feature.title}
              </h3>
              <p className="text-gray-600">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}