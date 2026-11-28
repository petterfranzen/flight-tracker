package com.flighttracker.config;

import com.flighttracker.controller.QueryParamsResolver;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.List;

/** Registers {@link QueryParamsResolver} for {@code @QueryParams} handler arguments. */
@Configuration
public class QueryParamsWebConfig implements WebMvcConfigurer {

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(new QueryParamsResolver());
    }
}
