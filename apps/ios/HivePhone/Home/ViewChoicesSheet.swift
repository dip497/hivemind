import SwiftUI

/// Home's View menu, as the desktop's: one choice each of status, activity, group by and sort by.
struct ViewChoicesSheet: View {
    @Binding var choices: HomeViewChoices
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(ViewChoiceGroup.all) { group in
                    Section {
                        ForEach(group.options) { option in
                            let chosen = choices[keyPath: group.choice] == option.id
                            Button {
                                choices[keyPath: group.choice] = option.id
                            } label: {
                                HStack {
                                    Text(option.label)
                                        .foregroundStyle(Look.text)
                                    Spacer()
                                    if chosen {
                                        Image(systemName: "checkmark")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(Look.text)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(chosen ? .isSelected : [])
                            .pageRow()
                        }
                    } header: {
                        GroupLabel(group.title)
                            .textCase(nil)
                    }
                }
            }
            .listStyle(.plain)
            .pageGround()
            .navigationTitle("View")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Reset") { choices.resetView() }
                        .disabled(choices.isDefault)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
