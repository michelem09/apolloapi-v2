const gql = require('graphql-tag');

module.exports = gql`
  directive @auth on FIELD_DEFINITION

  extend type Query {
    Auth: AuthActions
  }

  # Anything that changes state is a mutation: Apollo Client re-executes queries on
  # a re-render, and a phantom re-fire must never change the system password.
  extend type Mutation {
    Auth: AuthMutations
  }

  enum AuthStatus { pending, done }

  type AuthActions {
    login(input: AuthLoginInput!): AuthLoginOutput!
    status: AuthStatusOutput! 
  }

  type AuthMutations {
    changePassword(input: AuthChangePasswordInput!): AuthChangePasswordOutput! @auth
    "The one action open to anyone: first-boot password, refused once setup is done."
    setup(input: AuthSetupInput!): AuthSetupOutput!
  }

  input AuthLoginInput {
    password: String!
  }

  type AuthLoginOutput {
    result: AuthLoginResult
    error: Error
  }

  type AuthLoginResult {
    accessToken: String!
  }

  type AuthStatusOutput {
    result: AuthStatusResult
    error: Error
  }

  type AuthStatusResult {
    status: AuthStatus!
  }

  input AuthChangePasswordInput {
    password: String!
  }

  type AuthChangePasswordOutput {
    error: Error
  }

  input AuthSetupInput {
    password: String!
  }

  type AuthSetupOutput {
    error: Error
  }
`;